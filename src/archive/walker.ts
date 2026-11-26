import type { AddonLogger } from '../addons/isolation';
import { isNotFound } from '../guild-sync/notFound';
import type { FileFetcher } from './fileFetch';
import { describe, pageAuthors, type MemberSnapshots } from './members';
import { filesOf, parseRawMessage } from './parse';
import type { MessageRow, PostgresArchiveStore } from './store';
import type { ArchiveSource, ChannelProgress, RawMessage } from './types';

/** Messages per page: Discord's maximum. */
export const PAGE_SIZE = 100;
/** Pages one walk reads at most before giving other channels a turn. */
const MAX_PAGES_PER_WALK = 50;

export interface WalkDeps {
    readonly store: Pick<
        PostgresArchiveStore,
        | 'saveMessages'
        | 'optedOut'
        | 'saveFiles'
        | 'advance'
        | 'caughtUp'
        | 'setStatus'
        | 'failed'
    >;
    readonly source: Pick<ArchiveSource, 'page'>;
    readonly members: Pick<MemberSnapshots, 'refresh'>;
    readonly fetcher: Pick<FileFetcher, 'fetch'>;
    readonly logger: AddonLogger;
    readonly now: () => Date;
}

export interface WalkResult {
    readonly messages: number;
    readonly files: number;
    /** True when the walk stopped for time with pages left. */
    readonly more: boolean;
}

/** A page read from Discord: the messages and where the next one starts. */
interface Page {
    readonly messages: RawMessage[];
    /** The newest ID in the page, parsed or not; null for an empty page. */
    readonly lastId: string | null;
}

const SNOWFLAKE = /^\d{1,25}$/;
const byId = (a: RawMessage, b: RawMessage) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : 1;

/** The status of a Discord API error, when it has one. */
function statusOf(error: unknown): number | null {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === 'number' ? status : null;
}

/**
 * Walks a channel's messages oldest first, after where it last stopped.
 * Each page is stored before the walk moves past it, so a crash re-reads
 * at most one page, and storing is idempotent.
 */
export class ArchiveWalker {
    constructor(private readonly deps: WalkDeps) {}

    async walk(
        channel: ChannelProgress,
        deadline: number
    ): Promise<WalkResult> {
        let afterId = channel.afterId;
        let messages = 0;
        let files = 0;
        for (let n = 0; n < MAX_PAGES_PER_WALK; n++) {
            if (Date.now() >= deadline) return { messages, files, more: true };
            const page = await this.read(channel, afterId);
            if (!page) return { messages, files, more: false };
            if (page.lastId === null) {
                await this.deps.store.caughtUp(
                    channel.channelId,
                    this.deps.now()
                );
                return { messages, files, more: false };
            }
            files += await this.save(channel, page);
            messages += page.messages.length;
            afterId = page.lastId;
        }
        return { messages, files, more: true };
    }

    /** One page, or null when the walk must stop (recorded). */
    private async read(
        channel: ChannelProgress,
        afterId: string
    ): Promise<Page | null> {
        try {
            const raw = await this.deps.source.page(
                channel.channelId,
                afterId,
                PAGE_SIZE
            );
            return toPage(raw);
        } catch (error) {
            await this.stop(channel, error);
            return null;
        }
    }

    /** Stores a page's messages, authors and files; returns files stored. */
    private async save(channel: ChannelProgress, page: Page): Promise<number> {
        const { store, now } = this.deps;
        const authors = page.messages.map((m) => m.author.id);
        const out = await store.optedOut([...new Set(authors)]);
        const rows: MessageRow[] = page.messages.map((message) => ({
            message,
            redacted: out.has(message.author.id),
        }));
        await store.saveMessages(channel.guildId, rows, now());
        const kept = rows.filter((r) => !r.redacted).map((r) => r.message);
        await this.deps.members.refresh(channel.guildId, pageAuthors(kept));
        const refs = kept.flatMap(filesOf);
        await store.saveFiles(refs, now());
        let stored = 0;
        for (const ref of refs) {
            if ((await this.deps.fetcher.fetch(ref)) === 'stored') stored++;
        }
        await store.advance(
            channel.channelId,
            page.lastId ?? channel.afterId,
            page.messages.length,
            now()
        );
        return stored;
    }

    /** Records why a walk stopped: no access, or a failure to retry. */
    private async stop(channel: ChannelProgress, error: unknown) {
        const { store, now } = this.deps;
        const status = statusOf(error);
        if (status === 403 || isNotFound(error)) {
            await store.setStatus(channel.channelId, 'forbidden', now());
            this.deps.logger.info(
                `[archive] ${channel.kind} ${channel.channelId} skipped: Discord answered ${status ?? 404}`
            );
            return;
        }
        await store.failed(channel.channelId, describe(error), now());
        this.deps.logger.warn(
            `[archive] Walk of ${channel.kind} ${channel.channelId} failed: ${describe(error)}`
        );
    }
}

/** Parses and orders a page. Messages that do not parse are skipped. */
export function toPage(raw: readonly unknown[]): Page {
    let lastId: string | null = null;
    const messages: RawMessage[] = [];
    for (const item of raw.slice(0, PAGE_SIZE)) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && SNOWFLAKE.test(id)) {
            if (lastId === null || BigInt(id) > BigInt(lastId)) lastId = id;
        }
        const message = parseRawMessage(item);
        if (message) messages.push(message);
    }
    return { messages: messages.sort(byId), lastId };
}

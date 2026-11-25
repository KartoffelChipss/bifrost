import type { SnapshotSide } from '../addons/db/schema';
import type { AddonLogger } from '../addons/isolation';
import { KeyedQueue } from '../relay-extras/queue';
import type { ChannelLinker, LinkedChannel } from './links';
import {
    MemoryParkedMessages,
    type ParkedMessage,
    type ParkedMessageStore,
} from './parkedMessages';
import type { ThreadRelayStore } from './store';
import type { ThreadMirror } from './threadMirror';

export { MAX_PARKED_MESSAGES } from './parkedMessages';

/**
 * Relays messages posted inside synced threads and forum posts. Upstream's
 * relay handles only messages posted directly in a bridged text channel,
 * so this covers the rest: create, edit and delete, in both directions.
 *
 * A reply whose thread does not exist on the other side yet, or whose
 * thread history is still being copied, is parked (parkedMessages.ts) and
 * sent later. Order is kept per thread: while a thread has parked replies,
 * a new reply parks behind them, and a thread's parked replies are sent
 * oldest first, stopping at the first one that must still wait. Parked
 * threads are retried every {@link PARKED_POLL_MS} and after each sync
 * cycle. Work for one thread runs one task at a time.
 *
 * It is routing only. The platform work is behind {@link ThreadRelayPorts}.
 */

/** What the relay needs to know about a message, on either platform. */
export interface ThreadMessageEvent {
    readonly id: string;
    /** The channel the message is in. For a relayed message, a thread. */
    readonly channelId: string;
    /** The thread's parent channel, or null when this is not a thread. */
    readonly parentId: string | null;
    /** Set when a webhook posted the message. */
    readonly webhookId: string | null;
}

/** The platform side of the relay. `raw` is the platform's own message. */
export interface ThreadRelayPorts {
    /** Posts a copy in the thread on side `to`. Returns the new message ID. */
    send(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        raw: unknown
    ): Promise<string>;
    edit(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        messageId: string,
        raw: unknown
    ): Promise<void>;
    remove(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        messageId: string
    ): Promise<void>;
    /** A message on `side` as `raw`, or null when it is gone. */
    fetch(
        side: SnapshotSide,
        threadId: string,
        messageId: string
    ): Promise<unknown | null>;
}

export interface ThreadRelayDeps {
    readonly store: ThreadRelayStore;
    readonly links: ChannelLinker;
    readonly ports: ThreadRelayPorts;
    /** False while add-ons are read-only (guards 10 and 15). */
    readonly active: () => boolean;
    /**
     * True while a Fluxer thread's history is being copied. New Discord
     * replies wait, so they land below the history.
     */
    readonly importing?: (fluxerThreadId: string) => Promise<boolean>;
    /**
     * Creates the Discord copy of a thread started on Fluxer (see
     * threadMirror.ts). Without it, such a thread's replies wait and expire.
     */
    readonly mirror?: ThreadMirror['mirror'];
    /** Where parked replies are kept; in memory when unset. */
    readonly parked?: ParkedMessageStore;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

/** Long enough for the history of a busy post to be copied first. */
export const PARKED_TTL_MS = 6 * 60 * 60_000;
/** How often parked threads are retried. */
export const PARKED_POLL_MS = 15_000;
/** Upper bound on threads retried in one pass. */
export const MAX_THREADS_PER_FLUSH = 50;
/** Upper bound on one thread's replies sent in one pass. */
export const MAX_SENDS_PER_THREAD = 100;
/** A parked reply whose send fails this often is dropped. */
export const MAX_PARKED_FAILURES = 3;

type Outcome = 'relayed' | 'unmapped' | 'ignored';

const other = (side: SnapshotSide): SnapshotSide =>
    side === 'discord' ? 'fluxer' : 'discord';

const threadKey = (from: SnapshotSide, threadId: string) =>
    `${from}:${threadId}`;

export class ThreadRelay {
    private readonly parked: ParkedMessageStore;
    private readonly queue = new KeyedQueue();
    private timer: NodeJS.Timeout | null = null;
    private flushing: Promise<void> | null = null;

    constructor(private readonly deps: ThreadRelayDeps) {
        this.parked = deps.parked ?? new MemoryParkedMessages();
    }

    private linkFor(from: SnapshotSide, parentId: string) {
        return from === 'discord'
            ? this.deps.links.byDiscordChannel(parentId)
            : this.deps.links.byFluxerChannel(parentId);
    }

    /** True for a message the relay itself posted through its webhook. */
    private isOwn(
        from: SnapshotSide,
        event: ThreadMessageEvent,
        link: LinkedChannel
    ) {
        const own =
            from === 'discord' ? link.discordWebhook.id : link.fluxerWebhook.id;
        return event.webhookId !== null && event.webhookId === own;
    }

    /** The link of a message the relay copies, or null for one it skips. */
    private async relayable(from: SnapshotSide, event: ThreadMessageEvent) {
        if (!event.parentId) return null;
        const link = await this.linkFor(from, event.parentId);
        return !link || this.isOwn(from, event, link) ? null : link;
    }

    /** Runs relay work so a failure is logged and never escapes. */
    private async guarded(what: string, work: () => Promise<void>) {
        try {
            await work();
        } catch (error) {
            const detail = error instanceof Error ? error.message : error;
            this.deps.logger.warn(
                `[guild-sync] Thread relay ${what}: ${detail}`
            );
        }
    }

    /** The pair of the message's thread, mirroring a Fluxer thread first. */
    private async pairFor(
        from: SnapshotSide,
        link: LinkedChannel,
        event: ThreadMessageEvent,
        raw: unknown
    ) {
        const pair = await this.deps.store.findThreadPair(
            from,
            event.channelId
        );
        if (pair || from !== 'fluxer' || !this.deps.mirror) return { pair };
        const mirrored = await this.deps.mirror(link, event, raw);
        return {
            pair: mirrored?.pair ?? null,
            starterCopied: mirrored?.starterCopied === true,
        };
    }

    /** Sends a copy of a new message, or says why it must wait. */
    private async relay(
        from: SnapshotSide,
        link: LinkedChannel,
        event: ThreadMessageEvent,
        raw: unknown
    ): Promise<Outcome> {
        const { pair, starterCopied } = await this.pairFor(
            from,
            link,
            event,
            raw
        );
        if (starterCopied) return 'relayed';
        if (!pair) return 'unmapped';
        // History copies Discord to Fluxer only, so only Discord replies
        // wait for it. A Fluxer reply is never in the history it copies.
        if (from === 'discord' && (await this.deps.importing?.(pair.fluxerId)))
            return 'unmapped';
        const to = other(from);
        const threadId = to === 'fluxer' ? pair.fluxerId : pair.discordId;
        const copyId = await this.deps.ports.send(to, link, threadId, raw);
        await this.deps.store.saveThreadMessage(
            {
                guildLinkId: pair.guildLinkId,
                discordThreadId: pair.discordId,
                fluxerThreadId: pair.fluxerId,
                discordMessageId: from === 'discord' ? event.id : copyId,
                fluxerMessageId: from === 'fluxer' ? event.id : copyId,
            },
            this.deps.now()
        );
        return 'relayed';
    }

    private async park(from: SnapshotSide, event: ThreadMessageEvent) {
        // A forum post's first message has the post's own ID. The sync
        // posts it when it creates the post, so it is never parked.
        if (event.id === event.channelId || !event.parentId) return;
        await this.parked.park({
            from,
            messageId: event.id,
            threadId: event.channelId,
            parentId: event.parentId,
            webhookId: event.webhookId,
            parkedAt: this.deps.now().getTime(),
        });
    }

    async created(
        from: SnapshotSide,
        event: ThreadMessageEvent,
        raw: unknown
    ): Promise<void> {
        if (!this.deps.active()) return;
        const key = threadKey(from, event.channelId);
        await this.queue.run(key, () =>
            this.guarded('send', async () => {
                const link = await this.relayable(from, event);
                if (!link) return;
                // Older replies of this thread wait: this one goes after.
                if (await this.parked.waiting(from, event.channelId)) {
                    await this.park(from, event);
                    await this.drain(from, event.channelId);
                    return;
                }
                const result = await this.relay(from, link, event, raw);
                if (result === 'unmapped') await this.park(from, event);
            })
        );
    }

    /**
     * Retries parked threads. Called after each sync cycle, which creates
     * threads, and every {@link PARKED_POLL_MS} while flushing is on.
     */
    async flush(): Promise<void> {
        if (!this.deps.active()) return;
        await this.guarded('send', async () => {
            const cutoff = this.deps.now().getTime() - PARKED_TTL_MS;
            await this.parked.expire(cutoff);
            const threads = await this.parked.threads(MAX_THREADS_PER_FLUSH);
            for (const { from, threadId } of threads) {
                await this.queue.run(threadKey(from, threadId), () =>
                    this.guarded('send', () => this.drain(from, threadId))
                );
            }
        });
    }

    /** Sends a thread's parked replies in order, up to the first that waits. */
    private async drain(from: SnapshotSide, threadId: string): Promise<void> {
        const cutoff = this.deps.now().getTime() - PARKED_TTL_MS;
        const waiting = await this.parked.list(
            from,
            threadId,
            MAX_SENDS_PER_THREAD
        );
        for (const parked of waiting) {
            const done = parked.parkedAt < cutoff || (await this.retry(parked));
            if (!done) return;
            await this.parked.remove(from, parked.messageId);
        }
    }

    /** True when a parked reply is settled: sent, covered or gone. */
    private async retry(parked: ParkedMessage): Promise<boolean> {
        try {
            return await this.resend(parked);
        } catch (error) {
            const failures = await this.parked.failed(
                parked.from,
                parked.messageId
            );
            const detail = error instanceof Error ? error.message : error;
            this.deps.logger.warn(
                `[guild-sync] Thread relay send of held ${parked.messageId} failed (${failures}/${MAX_PARKED_FAILURES}): ${detail}`
            );
            // Keep the order; give up on a reply that keeps failing.
            if (failures < MAX_PARKED_FAILURES) return false;
            return true;
        }
    }

    private async resend(parked: ParkedMessage): Promise<boolean> {
        if (await this.coveredByHistory(parked)) return true;
        const event: ThreadMessageEvent = {
            id: parked.messageId,
            channelId: parked.threadId,
            parentId: parked.parentId,
            webhookId: parked.webhookId,
        };
        const link = await this.relayable(parked.from, event);
        if (!link) return true;
        const raw = await this.deps.ports.fetch(
            parked.from,
            parked.threadId,
            parked.messageId
        );
        // Deleted while it waited: there is nothing to copy.
        if (raw === null) return true;
        return (await this.relay(parked.from, link, event, raw)) !== 'unmapped';
    }

    /** A held Discord reply that the history import copied already. */
    private async coveredByHistory(parked: ParkedMessage): Promise<boolean> {
        if (parked.from !== 'discord') return false;
        const { threadId, messageId } = parked;
        return (
            (await this.deps.store.historyCovers?.(threadId, messageId)) ??
            false
        );
    }

    /** Retries parked threads every {@link PARKED_POLL_MS} until stopped. */
    startFlushing(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (this.flushing) return;
            this.flushing = this.flush().finally(() => {
                this.flushing = null;
            });
        }, PARKED_POLL_MS);
    }

    stopFlushing(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async edited(
        from: SnapshotSide,
        event: ThreadMessageEvent,
        raw: unknown
    ): Promise<void> {
        // A webhook edit is the relay's own write on this side.
        if (!this.deps.active() || event.webhookId || !event.parentId) return;
        const parentId = event.parentId;
        await this.guarded('edit', async () => {
            const copy = await this.deps.store.findThreadMessage(
                from,
                event.id
            );
            const link = copy ? await this.linkFor(from, parentId) : null;
            if (!copy || !link) return;
            const to = other(from);
            await this.deps.ports.edit(
                to,
                link,
                to === 'fluxer' ? copy.fluxerThreadId : copy.discordThreadId,
                to === 'fluxer' ? copy.fluxerMessageId : copy.discordMessageId,
                raw
            );
        });
    }

    /**
     * `parentId` is the parent channel of the thread the message was in,
     * `threadId` the thread. A parked copy of the message is dropped, so a
     * reply deleted while it waited is never posted.
     */
    async deleted(
        from: SnapshotSide,
        messageId: string,
        parentId: string | null,
        threadId?: string
    ): Promise<void> {
        if (!this.deps.active() || !parentId) return;
        const work = () =>
            this.guarded('delete', () =>
                this.removeCopy(from, messageId, parentId)
            );
        if (!threadId) return work();
        await this.queue.run(threadKey(from, threadId), work);
    }

    private async removeCopy(
        from: SnapshotSide,
        messageId: string,
        parentId: string
    ): Promise<void> {
        const { store, ports } = this.deps;
        if (await this.parked.remove(from, messageId)) return;
        const copy = await store.findThreadMessage(from, messageId);
        const link = copy ? await this.linkFor(from, parentId) : null;
        if (!copy || !link) return;
        await store.deleteThreadMessage(from, messageId);
        const to = other(from);
        await ports.remove(
            to,
            link,
            to === 'fluxer' ? copy.fluxerThreadId : copy.discordThreadId,
            to === 'fluxer' ? copy.fluxerMessageId : copy.discordMessageId
        );
    }
}

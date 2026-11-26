import type { AddonLogger } from '../addons/isolation';
import type { FileFetcher } from './fileFetch';
import { describe } from './members';
import { filesOf, parseRawMessage } from './parse';
import type { FileRetry, MessageRow, PostgresArchiveStore } from './store';
import type { ArchiveFileStore, ArchiveSource } from './types';

/** Files retried per pass at most. */
export const RETRIES_PER_PASS = 20;
/** Messages redacted per pass at most. */
const REDACTIONS_PER_PASS = 500;

export interface UpkeepDeps {
    readonly store: Pick<
        PostgresArchiveStore,
        | 'filesToRetry'
        | 'fileGone'
        | 'fileFailed'
        | 'redactOptedOut'
        | 'deleteMessage'
        | 'hasMessage'
        | 'optedOut'
        | 'saveMessages'
    >;
    readonly source: Pick<ArchiveSource, 'message'>;
    readonly fetcher: Pick<FileFetcher, 'fetch'>;
    readonly files: Pick<ArchiveFileStore, 'remove'>;
    readonly logger: AddonLogger;
    readonly now: () => Date;
}

/**
 * Work around the walk: files to fetch again, authors who opted out, and
 * Discord's edits and deletes of archived messages.
 */
export class ArchiveUpkeep {
    constructor(private readonly deps: UpkeepDeps) {}

    /**
     * Fetches files that failed or were held for space. Discord's file
     * links expire, so each message is read again for a fresh link.
     */
    async retryFiles(deadline: number): Promise<void> {
        const due = await this.deps.store.filesToRetry(RETRIES_PER_PASS);
        for (const file of due) {
            if (Date.now() >= deadline) return;
            await this.retry(file);
        }
    }

    private async retry(file: FileRetry): Promise<void> {
        const { store, now } = this.deps;
        try {
            const raw = await this.deps.source.message(
                file.channelId,
                file.messageId
            );
            const message = raw === null ? null : parseRawMessage(raw);
            const ref = message
                ? filesOf(message).find(
                      (f) =>
                          f.kind === file.kind && f.sourceId === file.sourceId
                  )
                : undefined;
            if (!ref) {
                await store.fileGone(file.kind, file.sourceId, now());
                return;
            }
            await this.deps.fetcher.fetch(ref);
        } catch (error) {
            await store.fileFailed(file.kind, file.sourceId, now());
            this.deps.logger.warn(
                `[archive] Retry of ${file.kind} ${file.sourceId} failed: ${describe(error)}`
            );
        }
    }

    /** Empties archived messages of authors who opted out of history. */
    async redactOptedOut(): Promise<number> {
        const hashes =
            await this.deps.store.redactOptedOut(REDACTIONS_PER_PASS);
        await this.removeBytes(hashes);
        return hashes.length;
    }

    /** Stores the edited message again, when it is archived. */
    async edited(guildId: string, channelId: string, messageId: string) {
        const { store, now } = this.deps;
        if (!(await store.hasMessage(messageId))) return;
        const raw = await this.deps.source.message(channelId, messageId);
        const message = raw === null ? null : parseRawMessage(raw);
        if (!message) return;
        const out = await store.optedOut([message.author.id]);
        const row: MessageRow = {
            message,
            redacted: out.has(message.author.id),
        };
        await store.saveMessages(guildId, [row], now());
    }

    /** Deletes a message Discord deleted, and files only it used. */
    async deleted(messageId: string): Promise<void> {
        const hashes = await this.deps.store.deleteMessage(messageId);
        await this.removeBytes(hashes);
    }

    private async removeBytes(hashes: readonly string[]): Promise<void> {
        for (const sha256 of hashes) await this.deps.files.remove(sha256);
    }
}

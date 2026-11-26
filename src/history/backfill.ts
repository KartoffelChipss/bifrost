import type { AddonLogger } from '../addons/isolation';
import { describeError, isTransient } from './errors';
import type { CopyFormatter } from './format';
import { PAGE_SIZE } from './limits';
import type {
    MentionStore,
    ScannedMessage,
    UnscannedCopy,
} from './mentionStore';
import { snowflakeAfter, type WorkBudget } from './mentions';
import type { HistoryStore } from './store';
import type { HistoryPorts, SourceMessage } from './types';

/**
 * Records the mentions of copies imported before mentions were recorded.
 * Their sources are read back from Discord a page of 100 at a time, by ID
 * range: one request covers up to 100 copies of a channel or thread. The
 * record on each copy is the progress, so a restart resumes where the last
 * page ended.
 */

/** Wait after each Discord page; discord.js waits out a 429 itself. */
export const BACKFILL_PAUSE_MS = 500;
/** Upper bound on pages one run reads, whatever the budget. */
const MAX_PAGES_PER_RUN = 100;

export interface BackfillDeps {
    readonly mentions: Pick<
        MentionStore,
        'scanJobs' | 'unscanned' | 'recordScan' | 'abandonScan'
    >;
    readonly store: Pick<HistoryStore, 'getJob'>;
    readonly ports: Pick<HistoryPorts, 'listMessages'>;
    readonly formatter: Pick<CopyFormatter, 'mentionsOf'>;
    readonly pause: (ms: number) => Promise<void>;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

/** The snowflake just before `id`, so a page after it starts at `id`. */
export function justBefore(id: string): string {
    const value = BigInt(id);
    return value > BigInt(0) ? (value - BigInt(1)).toString() : '0';
}

/**
 * The copies one Discord page settles: those it returned, and those in
 * its range it did not, which Discord no longer has. A full page ends at
 * its last message; past that, copies wait for the next page. A short
 * page reached the end, so it settles every copy.
 */
export function settledBy(
    copies: readonly UnscannedCopy[],
    page: readonly SourceMessage[],
    pageSize: number
): { found: SourceMessage[]; gone: string[] } {
    const byId = new Map(page.map((m) => [m.id, m]));
    const last = page[page.length - 1]?.id;
    const end = page.length >= pageSize && last ? last : null;
    const found: SourceMessage[] = [];
    const gone: string[] = [];
    for (const copy of copies) {
        const message = byId.get(copy.discordMessageId);
        if (message) found.push(message);
        else if (end === null || !snowflakeAfter(copy.discordMessageId, end))
            gone.push(copy.discordMessageId);
    }
    return { found, gone };
}

export class MentionBackfill {
    constructor(private readonly deps: BackfillDeps) {}

    /**
     * Reads pages for the link's copies while the budget allows. Returns
     * true when copies are left and the budget ran out.
     */
    async run(guildLinkId: string, budget: WorkBudget): Promise<boolean> {
        for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
            const [jobId] = await this.deps.mentions.scanJobs(guildLinkId, 1);
            if (!jobId) return false;
            if (!budget.takePage()) return true;
            await this.scanPage(guildLinkId, jobId);
        }
        return true;
    }

    /** Reads one page of a job's source and records what it settles. */
    private async scanPage(guildLinkId: string, jobId: string) {
        const { mentions, store, now } = this.deps;
        const copies = await mentions.unscanned(jobId, PAGE_SIZE);
        const first = copies[0];
        if (!first) return;
        const job = await store.getJob(jobId);
        if (!job) throw new Error(`history job ${jobId} is gone`);
        const page = await this.readPage(
            jobId,
            job.discordId,
            first.discordMessageId
        );
        if (page === null) return;
        const { found, gone } = settledBy(copies, page, PAGE_SIZE);
        const scanned: ScannedMessage[] = gone.map((id) => ({
            discordMessageId: id,
            discordUserIds: [],
        }));
        for (const message of found) {
            scanned.push({
                discordMessageId: message.id,
                discordUserIds: await this.deps.formatter.mentionsOf(message),
            });
        }
        await mentions.recordScan(guildLinkId, scanned, now());
    }

    /**
     * One page from Discord, starting at `firstId`. A temporary error is
     * thrown, to try again on a later pass. Any other, such as a deleted
     * channel or lost access, ends the job's backfill with no mentions:
     * its copies cannot be read back. Returns null then.
     */
    private async readPage(
        jobId: string,
        discordId: string,
        firstId: string
    ): Promise<SourceMessage[] | null> {
        try {
            return await this.deps.ports.listMessages(
                discordId,
                justBefore(firstId),
                PAGE_SIZE
            );
        } catch (error) {
            if (isTransient(error)) throw error;
            this.deps.logger.warn(
                `[history] Mentions of ${discordId} cannot be read back, so they stay unrecorded: ${describeError(error)}`
            );
            await this.deps.mentions.abandonScan(jobId);
            return null;
        } finally {
            await this.deps.pause(BACKFILL_PAUSE_MS);
        }
    }
}

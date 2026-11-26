import type { AddonLogger } from '../addons/isolation';
import type { LinkedGuild } from '../guild-sync/cycle';
import type { GuildWriter } from '../guild-sync/writers/writer';
import { describeError } from './errors';
import { PAGE_SIZE } from './limits';
import type { HistoryStore } from './store';
import { SURVEY_MAX_PAGES } from './survey';
import type { HistoryJob, HistoryPorts } from './types';

/**
 * Archive-thread mode for big channels (off unless BF_HISTORY_INLINE_MAX
 * is set). A channel with more messages than the limit gets its history
 * in a new thread of its Fluxer channel instead of inline, so the channel
 * can be bridged at once and live chat flows while the history is copied.
 *
 * Only text and announcement channels can hold threads on Fluxer
 * (packages/constants ThreadConstants TEXT_THREAD_PARENT_CHANNEL_TYPES);
 * a voice channel, or a thread that cannot be made, stays inline.
 */

/** Discord channel types whose Fluxer copy can hold a thread. */
const THREAD_PARENTS: ReadonlySet<number> = new Set([0, 5]);

export interface ArchiveDeps {
    /** Messages above which a channel's history goes to a thread; 0 is off. */
    readonly inlineMax: number;
    readonly ports: Pick<HistoryPorts, 'listMessages'>;
    readonly writer: Pick<GuildWriter, 'createThread' | 'updateThread'>;
    /** Records a new thread on its job before anything else can fail. */
    readonly store: Pick<HistoryStore, 'updateJob'>;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

/** The thread's name: the day the history ends. */
export function archiveName(cutoff: Date): string {
    return `History before ${cutoff.toISOString().slice(0, 10)}`;
}

/**
 * A thread is recorded on its job as soon as it is made. When a later
 * step fails, such as locking it or starting the job, the retry reuses it
 * instead of leaving an empty thread behind and making another.
 */
export class ArchiveThreads {
    constructor(private readonly deps: ArchiveDeps) {}

    /**
     * Makes the archive thread for a big channel and returns its ID, or
     * null when the channel imports inline. The thread starts locked; it
     * opens only while a page is sent. Only a thread that cannot be made
     * falls back to inline; a failure after that throws, so the job
     * retries with the same thread.
     */
    async open(
        link: LinkedGuild,
        job: HistoryJob,
        channelType: number | undefined,
        cutoff: Date
    ): Promise<string | null> {
        const { inlineMax } = this.deps;
        if (job.kind !== 'channel' || !job.fluxerId) return null;
        if (job.archiveThreadId) return this.lock(link, job.archiveThreadId);
        if (inlineMax <= 0) return null;
        if (channelType === undefined || !THREAD_PARENTS.has(channelType))
            return null;
        if ((await this.countUpTo(job, inlineMax)) <= inlineMax) return null;
        const id = await this.tryCreate(link, job, channelType, cutoff);
        return id === null ? null : this.keep(link, job, id);
    }

    /**
     * Makes the archive thread for a channel that was bridged before its
     * history was copied, whatever its size: inline copies would land
     * below the live messages. Returns null when its Fluxer copy cannot
     * hold a thread. Throws when the thread cannot be made, so the job
     * retries rather than losing its history.
     */
    async openForBridged(
        link: LinkedGuild,
        job: HistoryJob,
        channelType: number | undefined,
        linkedAt: Date
    ): Promise<string | null> {
        if (job.kind !== 'channel' || !job.fluxerId) return null;
        if (job.archiveThreadId) return this.lock(link, job.archiveThreadId);
        if (channelType === undefined) {
            throw new Error('the channel type is not known yet');
        }
        if (!THREAD_PARENTS.has(channelType)) return null;
        const id = await this.create(link, job.fluxerId, channelType, linkedAt);
        return this.keep(link, job, id);
    }

    /** Creates the thread, or logs why not and returns null. */
    private async tryCreate(
        link: LinkedGuild,
        job: HistoryJob,
        parentType: number,
        cutoff: Date
    ): Promise<string | null> {
        try {
            return await this.create(
                link,
                job.fluxerId ?? '',
                parentType,
                cutoff
            );
        } catch (error) {
            this.deps.logger.warn(
                `[history] No archive thread for channel ${job.discordId}, importing inline: ${describeError(error)}`
            );
            return null;
        }
    }

    /** Creates an archive thread named after the day it ends. */
    private async create(
        link: LinkedGuild,
        parentId: string,
        parentType: number,
        cutoff: Date
    ): Promise<string> {
        return this.deps.writer.createThread(link.fluxerGuildId, {
            parentId,
            parentType,
            name: archiveName(cutoff),
            tags: [],
            starter: null,
            webhook: null,
        });
    }

    /** Records a new thread on its job, then locks it. */
    private async keep(
        link: LinkedGuild,
        job: HistoryJob,
        threadId: string
    ): Promise<string> {
        const { store, now } = this.deps;
        await store.updateJob(job.id, { archiveThreadId: threadId }, now());
        return this.lock(link, threadId);
    }

    private async lock(link: LinkedGuild, threadId: string): Promise<string> {
        await this.deps.writer.updateThread(link.fluxerGuildId, threadId, {
            locked: true,
        });
        return threadId;
    }

    /** Locks and archives a finished archive thread for good. */
    async close(link: LinkedGuild, threadId: string): Promise<void> {
        await this.deps.writer.updateThread(link.fluxerGuildId, threadId, {
            archived: true,
            locked: true,
        });
    }

    /**
     * The channel's message count: the survey's, or counted now until it
     * passes `max` or the survey's page limit.
     */
    private async countUpTo(job: HistoryJob, max: number): Promise<number> {
        if (job.messageCount !== null) return job.messageCount;
        const pages = Math.min(
            Math.ceil((max + 1) / PAGE_SIZE),
            SURVEY_MAX_PAGES
        );
        let after = '0';
        let count = 0;
        for (let page = 0; page < pages; page++) {
            const batch = await this.deps.ports.listMessages(
                job.discordId,
                after,
                PAGE_SIZE
            );
            count += batch.filter((m) => m.copyable).length;
            if (batch.length < PAGE_SIZE || count > max) return count;
            after = batch[batch.length - 1].id;
        }
        return count;
    }
}

import type { AddonLogger } from '../addons/isolation';
import type { LinkedGuild } from '../guild-sync/cycle';
import { MAX_PARALLEL, PAGE_SIZE, SEND_INTERVAL_MS } from './limits';
import type { HistoryStore } from './store';
import type { HistoryJob, HistoryPorts } from './types';

/**
 * The dry-run survey: counts what an import would copy, once per job, and
 * reports the totals with a run-time estimate.
 */

/** Jobs counted per pass, and pages read per job. */
export const SURVEY_PER_RUN = 10;
export const SURVEY_MAX_PAGES = 200;
/**
 * Stored in lastError when a count stopped at SURVEY_MAX_PAGES, so the
 * report shows it as a lower bound. Starting the import clears it.
 */
export const SURVEY_CAPPED = 'survey stopped at the page limit';
/** An unreadable job is counted again after this long. */
export const SURVEY_RETRY_MS = 24 * 60 * 60_000;
/** Unreadable channels named in the report. */
const MAX_UNREADABLE_SHOWN = 10;

export interface SurveyDeps {
    readonly store: HistoryStore;
    readonly ports: Pick<HistoryPorts, 'listMessages'>;
    readonly report: (
        linkId: string,
        key: string,
        text: string
    ) => Promise<void>;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

/** A count is final once surveyedAt is set; this one could not be read. */
const unreadable = (j: HistoryJob) =>
    j.surveyedAt !== null && j.messageCount === null;
const capped = (j: HistoryJob) => j.lastError === SURVEY_CAPPED;

function countText(
    jobs: readonly HistoryJob[],
    field: 'messageCount' | 'attachmentCount'
) {
    const sum = jobs.reduce((total, j) => total + (j[field] ?? 0), 0);
    return jobs.some(capped) ? `>= ${sum}` : String(sum);
}

/**
 * Channels copy in parallel, each through its own webhook; the replies of
 * one parent's threads share that parent's bridge webhook. The run takes
 * as long as the largest of those queues, or the total spread over
 * MAX_PARALLEL slots, whichever is longer.
 */
export function estimateMinutes(jobs: readonly HistoryJob[]): number {
    const count = (j: HistoryJob) => j.messageCount ?? 0;
    const perParent = new Map<string, number>();
    let largest = 0;
    let total = 0;
    for (const job of jobs) {
        total += count(job);
        if (job.kind === 'channel') {
            largest = Math.max(largest, count(job));
            continue;
        }
        const parent = job.parentDiscordId ?? job.discordId;
        perParent.set(parent, (perParent.get(parent) ?? 0) + count(job));
    }
    for (const sum of perParent.values()) largest = Math.max(largest, sum);
    const slots = Math.max(largest, Math.ceil(total / MAX_PARALLEL));
    return Math.ceil((slots * SEND_INTERVAL_MS) / 60_000);
}

export function surveyText(jobs: readonly HistoryJob[]): string {
    const channels = jobs.filter((j) => j.kind === 'channel');
    const threads = jobs.filter((j) => j.kind === 'thread');
    const atLeast = jobs.some(capped) ? 'at least ' : '';
    const lines = [
        'History import (dry-run)',
        `Channels: ${channels.length}, ${countText(channels, 'messageCount')} messages`,
        `Posts and threads: ${threads.length}, ${countText(threads, 'messageCount')} replies`,
        `Attachments: ${countText(jobs, 'attachmentCount')}`,
        `Estimated run time: ${atLeast}about ${estimateMinutes(jobs)} minutes at full parallelism`,
    ];
    const failed = jobs.filter(unreadable);
    if (failed.length > 0) {
        const named = failed
            .slice(0, MAX_UNREADABLE_SHOWN)
            .map(
                (j) =>
                    `${j.kind} ${j.discordId} (${j.lastError ?? 'unknown error'})`
            );
        const more = failed.length - named.length;
        lines.push(
            `Could not read: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
        );
    }
    return lines.join('\n');
}

export class HistorySurvey {
    constructor(private readonly deps: SurveyDeps) {}

    /**
     * Counts jobs not counted yet, up to SURVEY_PER_RUN and the pass
     * deadline. Returns true while jobs are left to count.
     */
    async run(
        link: LinkedGuild,
        jobs: readonly HistoryJob[],
        deadline: number
    ): Promise<boolean> {
        const { store, now } = this.deps;
        const due = jobs.filter(
            (j) =>
                j.surveyedAt === null ||
                (unreadable(j) &&
                    now().getTime() - (j.surveyedAt?.getTime() ?? 0) >
                        SURVEY_RETRY_MS)
        );
        let counted = 0;
        for (const job of due.slice(0, SURVEY_PER_RUN)) {
            if (now().getTime() >= deadline) break;
            await this.surveyOne(job);
            counted += 1;
        }
        if (due.length > counted) return true;
        const ids = new Set(jobs.map((j) => j.id));
        const fresh = (await store.listJobs(link.id)).filter((j) =>
            ids.has(j.id)
        );
        const text = surveyText(fresh);
        this.deps.logger.info(`[history] ${text}`);
        await this.deps.report(link.id, `survey:${text}`, text);
        return false;
    }

    /** One unreadable channel is recorded, so it never stops the others. */
    private async surveyOne(job: HistoryJob): Promise<void> {
        const { store, now } = this.deps;
        try {
            const result = await this.count(job);
            await store.updateJob(
                job.id,
                {
                    messageCount: result.messages,
                    attachmentCount: result.attachments,
                    surveyedAt: now(),
                    lastError: result.capped ? SURVEY_CAPPED : null,
                },
                now()
            );
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : String(error);
            await store.updateJob(
                job.id,
                {
                    messageCount: null,
                    attachmentCount: null,
                    surveyedAt: now(),
                    lastError: detail,
                },
                now()
            );
            this.deps.logger.warn(
                `[history] Could not count ${job.kind} ${job.discordId}: ${detail}`
            );
        }
    }

    private async count(job: HistoryJob) {
        let after = '0';
        let messages = 0;
        let attachments = 0;
        for (let page = 0; page < SURVEY_MAX_PAGES; page++) {
            const batch = await this.deps.ports.listMessages(
                job.discordId,
                after,
                PAGE_SIZE
            );
            for (const m of batch) {
                if (!m.copyable || m.id === job.discordId) continue;
                messages += 1;
                attachments += m.attachments;
            }
            if (batch.length < PAGE_SIZE) {
                return { messages, attachments, capped: false };
            }
            after = batch[batch.length - 1].id;
        }
        return { messages, attachments, capped: true };
    }
}

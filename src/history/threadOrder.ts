import {
    compareSnowflakes,
    lastActivityId,
    type GuildSnapshot,
} from '../guild-sync/snapshot';
import type { HistoryJob } from './types';

/**
 * Fluxer cannot backdate a message, and forums can sort posts by their
 * latest activity (packages/schema ForumRequestSchemas, LATEST_ACTIVITY).
 * A thread's latest activity on Fluxer is its last copied message, so the
 * thread imports of one parent channel run one at a time, oldest Discord
 * activity first: each thread's last copy then lands in Discord's order.
 */

/** What orders the thread imports of one pass. */
export interface ThreadOrder {
    /** Discord thread ID to its latest activity, from guild-sync's snapshot. */
    readonly activity: ReadonlyMap<string, string>;
    /** Per Discord parent channel, its newest thread with a Fluxer copy. */
    readonly newestCopied: ReadonlyMap<string, string>;
    /** True when a snapshot listed the threads (see `gone`). */
    readonly listed: boolean;
    /** Parent channels whose thread list is incomplete. */
    readonly gaps: ReadonlySet<string>;
}

/**
 * The order from the latest snapshot and the Discord threads that have a
 * Fluxer copy. Without a snapshot every job falls back to its thread ID.
 */
export function threadOrder(
    snapshot: GuildSnapshot | null,
    copied: ReadonlySet<string>
): ThreadOrder {
    const activity = new Map<string, string>();
    const newestCopied = new Map<string, string>();
    for (const thread of snapshot?.threads ?? []) {
        activity.set(thread.id, lastActivityId(thread));
        if (!copied.has(thread.id)) continue;
        const newest = newestCopied.get(thread.parentId);
        if (newest === undefined || compareSnowflakes(thread.id, newest) > 0)
            newestCopied.set(thread.parentId, thread.id);
    }
    return {
        activity,
        newestCopied,
        listed: snapshot !== null,
        gaps: new Set(snapshot?.threadGaps ?? []),
    };
}

/** The activity a job is ordered by; its thread ID when not known. */
function activityOf(job: HistoryJob, order: ThreadOrder): string {
    return order.activity.get(job.discordId) ?? job.discordId;
}

/** True when `a` comes before `b`: older activity, then older thread. */
function before(a: HistoryJob, b: HistoryJob, order: ThreadOrder): boolean {
    const byActivity = compareSnowflakes(
        activityOf(a, order),
        activityOf(b, order)
    );
    if (byActivity !== 0) return byActivity < 0;
    return compareSnowflakes(a.discordId, b.discordId) < 0;
}

/** A thread with no Fluxer copy that Discord no longer lists. */
function gone(job: HistoryJob, order: ThreadOrder): boolean {
    if (!order.listed || order.activity.has(job.discordId)) return false;
    return !order.gaps.has(job.parentDiscordId ?? '');
}

/**
 * True for a job no other waits for: its thread has no Fluxer copy and
 * never gets one in order. guild-sync creates posts oldest first, so a
 * newer copied post in the same parent means it went past this one
 * (postOrder.ts MAX_BLOCKING_FAILURES); a deleted thread never gets one.
 */
function passedOver(job: HistoryJob, order: ThreadOrder): boolean {
    if (job.fluxerId !== null) return false;
    if (gone(job, order)) return true;
    const newest = order.newestCopied.get(job.parentDiscordId ?? '');
    return newest !== undefined && compareSnowflakes(newest, job.discordId) > 0;
}

const isOpen = (job: HistoryJob) =>
    job.status !== 'done' && job.status !== 'failed';

/** The open thread jobs that keep order, by parent channel. */
function queues(
    jobs: readonly HistoryJob[],
    order: ThreadOrder
): Map<string, HistoryJob[]> {
    const byParent = new Map<string, HistoryJob[]>();
    for (const job of jobs) {
        if (job.kind !== 'thread' || !isOpen(job)) continue;
        if (passedOver(job, order)) continue;
        const parent = job.parentDiscordId ?? '';
        const queue = byParent.get(parent) ?? [];
        queue.push(job);
        byParent.set(parent, queue);
    }
    return byParent;
}

/**
 * Whose turn it is. `turns`: per parent channel, the open thread job
 * with the oldest activity; it alone may run, even while it waits out a
 * backoff or for its Fluxer copy, so no newer one finishes first. A
 * done or failed job no longer waits anyone. `queued`: parents with
 * more jobs behind their turn.
 */
export function threadTurns(
    jobs: readonly HistoryJob[],
    order: ThreadOrder
): { turns: Set<string>; queued: Set<string> } {
    const turns = new Set<string>();
    const queued = new Set<string>();
    for (const [parent, queue] of queues(jobs, order)) {
        const first = queue.reduce((a, b) => (before(b, a, order) ? b : a));
        turns.add(first.id);
        if (queue.length > 1) queued.add(parent);
    }
    return { turns, queued };
}

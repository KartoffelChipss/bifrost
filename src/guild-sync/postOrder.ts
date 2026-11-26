import type { Finding, PlanOp } from './ops';
import { compareSnowflakes, type ThreadSnap } from './snapshot';

/**
 * Fluxer cannot backdate a post: a copy's creation time is when the bot
 * made it, and forums can sort by it (packages/schema ForumRequestSchemas
 * ForumSortOrderSchema, CREATION_TIME). So posts and threads are created
 * oldest first in each parent channel, and a newer one never goes ahead
 * of an older one that is still to be created.
 */

/**
 * Failures in a row after which a post stops holding up the newer posts
 * in its channel. They go ahead, and the broken post lands out of order
 * whenever it is created. With failures.ts's backoff this is a few hours.
 */
export const MAX_BLOCKING_FAILURES = 5;

/** The skip reason of a create that waits for an older one. */
export const WAITS_FOR_OLDER = 'waits for an older post in this channel';

/** A thread or forum post create. */
export type ThreadCreate = Extract<PlanOp, { op: 'create' }> & {
    readonly kind: 'thread';
};

export function isThreadCreate(op: PlanOp): op is ThreadCreate {
    return op.op === 'create' && op.kind === 'thread';
}

/**
 * Puts the new threads of each parent oldest first, by snowflake. They
 * take the places new threads of that parent held, so the order between
 * parents and the place of every mapped thread stay as they were.
 */
export function oldestFirstPerParent(
    threads: readonly ThreadSnap[],
    isNew: (thread: ThreadSnap) => boolean
): ThreadSnap[] {
    const queues = new Map<string, ThreadSnap[]>();
    for (const thread of threads) {
        if (!isNew(thread)) continue;
        const queue = queues.get(thread.parentId) ?? [];
        queue.push(thread);
        queues.set(thread.parentId, queue);
    }
    for (const queue of queues.values()) {
        queue.sort((a, b) => compareSnowflakes(a.id, b.id));
    }
    const taken = new Map<string, number>();
    return threads.map((thread) => {
        if (!isNew(thread)) return thread;
        const index = taken.get(thread.parentId) ?? 0;
        taken.set(thread.parentId, index + 1);
        return queues.get(thread.parentId)?.[index] ?? thread;
    });
}

/** Source thread ID to source parent channel ID. */
export function threadParents(
    threads: readonly ThreadSnap[]
): Map<string, string> {
    return new Map(threads.map((t) => [t.id, t.parentId]));
}

/**
 * Per parent channel, the oldest post that newer ones wait for. A
 * create in that parent waits when it is newer than the blocker.
 */
export class PostBlockers {
    private readonly oldest = new Map<string, string>();

    constructor(private readonly parents: ReadonlyMap<string, string>) {}

    /** The parent of a thread create, or null when unknown. */
    parentOf(op: PlanOp): string | null {
        if (!isThreadCreate(op)) return null;
        return this.parents.get(op.sourceId) ?? null;
    }

    /** Marks `op` as not created this cycle: newer ones in its parent wait. */
    block(op: PlanOp): void {
        const parent = this.parentOf(op);
        if (parent === null || !isThreadCreate(op)) return;
        const current = this.oldest.get(parent);
        if (
            current === undefined ||
            compareSnowflakes(op.sourceId, current) < 0
        )
            this.oldest.set(parent, op.sourceId);
    }

    /** The older post `op` waits for, or null when it may go ahead. */
    waitsFor(op: PlanOp): string | null {
        const parent = this.parentOf(op);
        if (parent === null || !isThreadCreate(op)) return null;
        const blocker = this.oldest.get(parent);
        if (blocker === undefined) return null;
        return compareSnowflakes(op.sourceId, blocker) > 0 ? blocker : null;
    }
}

/** What the failure ledger says of one create. */
export interface CreateHistory {
    /** Waiting out a backoff: it is skipped this cycle. */
    readonly held: boolean;
    /** Failures in a row so far. */
    readonly failures: number;
}

/** A finding for a post that no longer holds newer ones up. */
function brokenFinding(op: ThreadCreate, failures: number): Finding {
    return {
        type: 'skipped',
        kind: 'thread',
        id: op.sourceId,
        detail: `post "${op.name}" failed ${failures} times in a row; newer posts in its channel no longer wait for it, so it lands out of order once it is created`,
    };
}

/** One finding per parent whose newer posts wait. */
function waitingFindings(
    waiting: ReadonlyMap<string, { count: number; blocker: string }>
): Finding[] {
    return [...waiting].map(([parent, { count, blocker }]) => ({
        type: 'skipped',
        kind: 'channel',
        id: parent,
        detail: `${count} posts ${WAITS_FOR_OLDER}: post ${blocker} is retried after a backoff`,
    }));
}

/**
 * Takes out the thread creates that wait behind an older post held by
 * the failure ledger, so they take no write-cap slot. A post that failed
 * MAX_BLOCKING_FAILURES times holds nothing up and gets a finding.
 */
export function holdNewerPosts(
    ops: readonly PlanOp[],
    parents: ReadonlyMap<string, string>,
    historyOf: (op: ThreadCreate) => CreateHistory
): { kept: PlanOp[]; findings: Finding[] } {
    const blockers = new PostBlockers(parents);
    const findings: Finding[] = [];
    for (const op of ops) {
        if (!isThreadCreate(op)) continue;
        const history = historyOf(op);
        if (history.failures >= MAX_BLOCKING_FAILURES) {
            findings.push(brokenFinding(op, history.failures));
        } else if (history.held) blockers.block(op);
    }
    const waiting = new Map<string, { count: number; blocker: string }>();
    const kept = ops.filter((op) => {
        const blocker = blockers.waitsFor(op);
        const parent = blockers.parentOf(op);
        if (blocker === null || parent === null) return true;
        const count = (waiting.get(parent)?.count ?? 0) + 1;
        waiting.set(parent, { count, blocker });
        return false;
    });
    return { kept, findings: [...findings, ...waitingFindings(waiting)] };
}

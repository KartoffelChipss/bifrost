import type { AddonLogger } from '../addons/isolation';
import type { ApplyResult } from './apply';
import type { PlanOp } from './ops';
import { summarizePlan, type Plan } from './plan';
import { stableJson } from './snapshot';

/**
 * What guild-sync tells the admins, and when. Routine state lives in the
 * link's status message (statusBoard.ts); a notice is a new message for
 * something an admin must act on or know about. Within one category, the
 * same notice is not sent twice in a row, so a plan that stays the same for
 * hours is posted once, and one category cannot reset another's dedupe.
 */

/** Sends one text to a channel. Rejects on failure. */
export type SendNotice = (channelId: string, text: string) => Promise<void>;

/** Upper bound on remembered (link, category) keys; past it, all are forgotten. */
export const MAX_NOTICE_KEYS = 1_000;

export class NoticeBoard {
    private readonly lastKey = new Map<string, string>();

    constructor(
        private readonly send: SendNotice,
        private readonly logger: AddonLogger
    ) {}

    /**
     * Posts unless `key` equals the last key posted for this link in this
     * category.
     */
    async post(
        linkId: string,
        category: string,
        channelId: string | null,
        key: string,
        text: string
    ): Promise<void> {
        const slot = `${linkId}\n${category}`;
        if (!channelId || this.lastKey.get(slot) === key) return;
        if (this.lastKey.size >= MAX_NOTICE_KEYS) this.lastKey.clear();
        this.lastKey.set(slot, key);
        try {
            await this.send(channelId, text);
        } catch (error) {
            // A notice that cannot be posted must not stop a cycle.
            const detail = error instanceof Error ? error.message : error;
            this.logger.warn(`[guild-sync] Could not post a notice: ${detail}`);
        }
    }
}

/** A notice to post: its dedupe category and key, and its text. */
export interface Alert {
    readonly category: 'approval' | 'abort' | 'apply-failed';
    readonly key: string;
    readonly text: string;
}

/** Identifies what a plan would do, apart from its ID and time. */
export function planFingerprint(plan: Plan): string {
    const { ops, deferred, needsApproval, approvalReason } = plan.body;
    const restores = plan.body.restores ?? [];
    return stableJson({
        ops,
        deferred,
        needsApproval,
        approvalReason,
        abortReason: plan.abortReason,
        // Absent without restores, so older fingerprints stay the same.
        ...(restores.length > 0 ? { restores } : {}),
    });
}

/** The plan summary with the commands that approve or reject it. */
function approvalText(plan: Plan, prefix: string): string {
    return [
        summarizePlan(plan),
        '',
        `To approve: \`${prefix}sync approve ${plan.id}\``,
        `To reject: \`${prefix}sync reject ${plan.id}\``,
    ].join('\n');
}

/**
 * The alert for a saved plan: one that waits for approval, or one a gate
 * aborted. Null for a routine plan, which only the status message shows.
 */
export function planAlert(plan: Plan, prefix: string): Alert | null {
    if (plan.status === 'pending-approval') {
        return {
            category: 'approval',
            key: planFingerprint(plan),
            text: approvalText(plan, prefix),
        };
    }
    if (!plan.abortReason) return null;
    return {
        category: 'abort',
        key: planFingerprint(plan),
        text: summarizePlan(plan),
    };
}

const MAX_LISTED = 5;

/** One line for the logs: what an apply run did. */
export function applyNotice(plan: Plan, result: ApplyResult): string {
    const lines = [
        `Applied plan ${plan.id}: ${result.applied} written, ${result.failed} failed, ${result.skipped.length} not applied`,
    ];
    if (result.stopped) lines.push(`Stopped early: ${result.stopped}`);
    for (const { op, reason } of result.skipped.slice(0, MAX_LISTED)) {
        lines.push(`- ${op.op} ${op.kind} not applied: ${reason}`);
    }
    return lines.join('\n');
}

/** An op by what it writes, apart from its field values. */
function opIdentity(op: PlanOp): string {
    if ('destId' in op) return `${op.op} ${op.kind} ${op.destId}`;
    if ('sourceId' in op) return `${op.op} ${op.kind} ${op.sourceId}`;
    return `${op.op} ${op.kind}`;
}

/**
 * Identifies a set of failures: the failing ops and their reasons, with
 * numbers in the reasons blurred, so a retry-after or a count that moves
 * does not make the same failure look new.
 */
export function failureFingerprint(result: ApplyResult): string {
    const blur = (text: string) => text.replace(/\d+/g, '#');
    const failures = result.failures
        .map(({ op, reason }) => `${opIdentity(op)}: ${blur(reason)}`)
        .sort();
    const stopped = result.stopped === null ? null : blur(result.stopped);
    return stableJson({ failures, stopped });
}

/** The text of an apply-failure alert: counts, stop reason, first failures. */
function failureText(plan: Plan, result: ApplyResult): string {
    const lines = [
        `Apply of plan ${plan.id} had problems: ${result.applied} written, ${result.failed} failed`,
    ];
    if (result.stopped) lines.push(`Stopped early: ${result.stopped}`);
    for (const { op, reason } of result.failures.slice(0, MAX_LISTED)) {
        lines.push(`- ${opIdentity(op)} failed: ${reason}`);
    }
    const rest = result.failures.length - MAX_LISTED;
    if (rest > 0) lines.push(`- and ${rest} more`);
    return lines.join('\n');
}

/** The alert for an apply run that failed or stopped early, or null. */
export function applyAlert(plan: Plan, result: ApplyResult): Alert | null {
    if (result.failed === 0 && result.stopped === null) return null;
    return {
        category: 'apply-failed',
        key: failureFingerprint(result),
        text: failureText(plan, result),
    };
}

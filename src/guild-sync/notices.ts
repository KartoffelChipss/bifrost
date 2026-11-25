import type { AddonLogger } from '../addons/isolation';
import type { ApplyResult } from './apply';
import { summarizePlan, type Plan } from './plan';
import { stableJson } from './snapshot';

/**
 * What guild-sync tells the admins, and when. A notice goes to the link's
 * admin channel. The same notice is not sent twice in a row, so a plan
 * that stays the same for hours is posted once.
 */

/** Sends one text to a channel. Rejects on failure. */
export type SendNotice = (channelId: string, text: string) => Promise<void>;

export class NoticeBoard {
    private readonly lastKey = new Map<string, string>();

    constructor(
        private readonly send: SendNotice,
        private readonly logger: AddonLogger
    ) {}

    /** Posts unless `key` equals the last key posted for this link. */
    async post(
        linkId: string,
        channelId: string | null,
        key: string,
        text: string
    ): Promise<void> {
        if (!channelId || this.lastKey.get(linkId) === key) return;
        this.lastKey.set(linkId, key);
        try {
            await this.send(channelId, text);
        } catch (error) {
            // A notice that cannot be posted must not stop a cycle.
            const detail = error instanceof Error ? error.message : error;
            this.logger.warn(`[guild-sync] Could not post a notice: ${detail}`);
        }
    }
}

/** Identifies what a plan would do, apart from its ID and time. */
export function planFingerprint(plan: Plan): string {
    const { ops, deferred, needsApproval, approvalReason } = plan.body;
    return stableJson({
        ops,
        deferred,
        needsApproval,
        approvalReason,
        abortReason: plan.abortReason,
    });
}

/** The notice for a saved plan, or null when the plan says nothing new. */
export function planNotice(plan: Plan, prefix: string): string | null {
    const { body } = plan;
    const quiet =
        !plan.abortReason &&
        !body.needsApproval &&
        body.ops.length === 0 &&
        body.deferred.length === 0;
    if (quiet) return null;
    const lines = [summarizePlan(plan)];
    if (plan.status === 'pending-approval') {
        lines.push(
            '',
            `To approve: \`${prefix}sync approve ${plan.id}\``,
            `To reject: \`${prefix}sync reject ${plan.id}\``
        );
    }
    return lines.join('\n');
}

const MAX_LISTED = 5;

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

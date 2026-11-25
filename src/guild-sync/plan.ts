import type { PlanStatus, SyncDirection } from '../addons/db/schema';
import type { Finding, PlanOp } from './ops';

/** A plan as stored in `addon_plans.ops`. */
export interface PlanBody {
    readonly ops: readonly PlanOp[];
    /** Over the write cap (guard 14). Recomputed by a later cycle. */
    readonly deferred: readonly PlanOp[];
    readonly findings: readonly Finding[];
    readonly needsApproval: boolean;
    readonly approvalReason: string | null;
}

export interface Plan {
    readonly id: string;
    readonly guildLinkId: string;
    readonly direction: SyncDirection;
    readonly status: PlanStatus;
    readonly body: PlanBody;
    readonly abortReason: string | null;
}

export const EMPTY_BODY: PlanBody = {
    ops: [],
    deferred: [],
    findings: [],
    needsApproval: false,
    approvalReason: null,
};

/** How many ops a summary lists before it stops (design: Approval flow). */
export const SUMMARY_OP_LIMIT = 20;

function describeOp(op: PlanOp): string {
    switch (op.op) {
        case 'create': {
            const match = op.existingDestId
                ? ` (unmapped destination ${op.kind} ${op.existingDestId} has the same name)`
                : '';
            return `create ${op.kind} "${op.name}"${match}`;
        }
        case 'update':
            return `update ${op.kind} ${op.destId}: ${op.changes.map((c) => c.field).join(', ')}${op.baseline ? ' (first sync)' : ''}`;
        case 'reorder':
            return `reorder ${op.kind}s in ${op.scope} (${op.destIds.length})`;
        case 'link':
            return `link channel ${op.sourceId} to ${op.destId}`;
        case 'archive':
            return `archive ${op.kind} ${op.destId}`;
        case 'hard-delete':
            return `hard-delete ${op.kind} ${op.destId}${op.adopted ? ' (adopted)' : ''}`;
    }
}

function tally(names: readonly string[]): string {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].map(([name, n]) => `${name} ${n}`).join(', ') || 'none';
}

/** A plain-text summary: counts, then the first ops. */
export function summarizePlan(plan: Plan): string {
    const { body } = plan;
    const lines = [`Plan ${plan.id} (${plan.status}, ${plan.direction})`];
    if (plan.abortReason) {
        lines.push(`Aborted: ${plan.abortReason}`);
        return lines.join('\n');
    }
    lines.push(`Ops: ${tally(body.ops.map((op) => `${op.op} ${op.kind}`))}`);
    if (body.deferred.length > 0) {
        lines.push(`Deferred over the write cap: ${body.deferred.length}`);
    }
    lines.push(`Findings: ${tally(body.findings.map((f) => f.type))}`);
    if (body.needsApproval)
        lines.push(`Needs approval: ${body.approvalReason}`);
    for (const op of body.ops.slice(0, SUMMARY_OP_LIMIT)) {
        lines.push(`- ${describeOp(op)}`);
    }
    const rest = body.ops.length - SUMMARY_OP_LIMIT;
    if (rest > 0) lines.push(`- and ${rest} more`);
    return lines.join('\n');
}

import type { SyncDirection } from '../addons/db/schema';
import type { Finding, MapRow, PlanOp, SyncKind } from './ops';
import { destIdOf, isRemoval, sourceIdOf } from './ops';
import type { IdMap } from './idmap';
import type { GuildSnapshot } from './snapshot';
import { channelKind } from './snapshot';

/** The guard settings one cycle reads from `addon_settings`. */
export interface GuardSettings {
    readonly confirmChecks: number;
    readonly confirmMinutes: number;
    readonly gracePeriodDays: number;
    readonly deleteBudgetPerCycle: number;
    readonly deleteBudgetPerDay: number;
    readonly writeCapPerCycle: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface MissingUpdate {
    readonly rowId: string;
    readonly missingCount: number;
    readonly missingSince: Date | null;
}

function presentSourceIds(source: GuildSnapshot): Map<SyncKind, Set<string>> {
    const categories = source.channels.filter(
        (c) => channelKind(c.type) === 'category'
    );
    const channels = source.channels.filter(
        (c) => channelKind(c.type) !== 'category'
    );
    const ids = (items: readonly { id: string }[]) =>
        new Set(items.map((i) => i.id));
    return new Map<SyncKind, Set<string>>([
        ['role', ids(source.roles)],
        ['category', ids(categories)],
        ['channel', ids(channels)],
        ['emoji', ids(source.emojis)],
        ['sticker', ids(source.stickers)],
        // With a gap in the thread list, no thread may count as missing.
        ...(source.threadGaps.length === 0
            ? [['thread', ids(source.threads)] as [SyncKind, Set<string>]]
            : []),
    ]);
}

/**
 * Counts consecutive healthy checks in which each mapped object was absent
 * from the source (guard 4). Run only after the health gate passed, so a
 * failed read never advances a counter. Returns only rows that change.
 */
export function trackMissing(
    rows: readonly MapRow[],
    source: GuildSnapshot,
    direction: SyncDirection,
    now: Date
): MissingUpdate[] {
    const present = presentSourceIds(source);
    const updates: MissingUpdate[] = [];
    for (const row of rows) {
        const ids = present.get(row.kind as SyncKind);
        const sourceId = sourceIdOf(row, direction);
        if (!ids || !sourceId || row.state === 'tombstoned') continue;
        if (ids.has(sourceId)) {
            if (row.missingCount > 0 || row.missingSince) {
                updates.push({
                    rowId: row.id,
                    missingCount: 0,
                    missingSince: null,
                });
            }
            continue;
        }
        updates.push({
            rowId: row.id,
            missingCount: row.missingCount + 1,
            missingSince: row.missingSince ?? now,
        });
    }
    return updates;
}

/** Rows whose state after `trackMissing` is applied. */
export function applyMissing(
    rows: readonly MapRow[],
    updates: readonly MissingUpdate[]
): MapRow[] {
    const byId = new Map(updates.map((u) => [u.rowId, u]));
    return rows.map((row) => {
        const update = byId.get(row.id);
        return update ? { ...row, ...update } : row;
    });
}

/**
 * Rows that passed the count and time parts of guard 4. Each still needs a
 * direct REST lookup that returns Unknown before any removal is planned.
 */
export function removalCandidates(
    rows: readonly MapRow[],
    settings: GuardSettings,
    now: Date
): MapRow[] {
    return rows.filter((row) => {
        if (row.state === 'tombstoned') return false;
        if (row.kind === 'guild' || row.kind === 'overwrite') return false;
        if (!row.missingSince) return false;
        const elapsed = now.getTime() - row.missingSince.getTime();
        return (
            row.missingCount >= settings.confirmChecks &&
            elapsed >= settings.confirmMinutes * MINUTE_MS
        );
    });
}

function removalFor(
    row: MapRow,
    direction: SyncDirection,
    settings: GuardSettings,
    now: Date
): PlanOp | Finding {
    const sourceId = sourceIdOf(row, direction) ?? '';
    const destId = destIdOf(row, direction) ?? '';
    const kind = row.kind as SyncKind;
    if (row.state === 'active')
        return { op: 'archive', kind, sourceId, destId };
    // The grace period runs from when the object first went missing, which
    // is at least confirmMinutes before it could be archived.
    const elapsed =
        now.getTime() - (row.missingSince?.getTime() ?? now.getTime());
    if (elapsed < settings.gracePeriodDays * DAY_MS) {
        return {
            type: 'removal-deferred',
            kind,
            id: destId,
            detail: 'archived, in the grace period (guard 6)',
        };
    }
    return {
        op: 'hard-delete',
        kind,
        sourceId,
        destId,
        adopted: !row.createdBySync,
    };
}

/**
 * Archive and hard-delete ops for confirmed-gone rows (guards 4, 5, 6).
 * A candidate whose lookup did not return Unknown is deferred.
 */
export function planRemovals(
    candidates: readonly MapRow[],
    confirmedGone: ReadonlySet<string>,
    direction: SyncDirection,
    settings: GuardSettings,
    now: Date
): { ops: PlanOp[]; findings: Finding[] } {
    const ops: PlanOp[] = [];
    const findings: Finding[] = [];
    for (const row of candidates) {
        if (!confirmedGone.has(row.id)) {
            findings.push({
                type: 'removal-deferred',
                kind: row.kind as SyncKind,
                id: destIdOf(row, direction) ?? row.id,
                detail: 'missing from the source, but a direct lookup did not confirm it is gone (guard 4)',
            });
            continue;
        }
        const result = removalFor(row, direction, settings, now);
        if ('op' in result) ops.push(result);
        else findings.push(result);
    }
    return { ops, findings };
}

/**
 * Ownership (guard 1), the last filter before a plan is saved. Every op
 * that touches an existing destination object must name one the bot owns.
 * Removals never touch @everyone, the guild or the bot's own roles.
 */
export function enforceOwnership(
    ops: readonly PlanOp[],
    map: IdMap,
    protectedDestIds: ReadonlySet<string>
): { kept: PlanOp[]; dropped: Finding[] } {
    const kept: PlanOp[] = [];
    const dropped: Finding[] = [];
    const drop = (op: PlanOp, id: string) =>
        dropped.push({
            type: 'dropped-by-ownership',
            kind: op.kind,
            id,
            detail: `${op.op} on an object the bot does not own (guard 1)`,
        });
    for (const op of ops) {
        if (op.op === 'create') kept.push(op);
        else if (op.op === 'update') {
            if (map.mayUpdate(op.kind, op.destId)) kept.push(op);
            else drop(op, op.destId);
        } else if (op.op === 'reorder') {
            const kind = op.kind === 'role' ? 'role' : 'channel';
            const owned = op.destIds.filter(
                (id) => map.owns(kind, id) || map.owns('category', id)
            );
            if (owned.length === op.destIds.length) kept.push(op);
            else drop(op, op.scope);
        } else if (
            map.owns(op.kind, op.destId) &&
            !protectedDestIds.has(op.destId)
        ) {
            kept.push(op);
        } else drop(op, op.destId);
    }
    return { kept, dropped };
}

export type BudgetResult =
    | { readonly needsApproval: false }
    | { readonly needsApproval: true; readonly reason: string };

/**
 * Delete budget (guard 7). Over the cap, or with any hard delete of an
 * adopted object, the whole plan waits for approval.
 */
export function checkDeleteBudget(
    ops: readonly PlanOp[],
    settings: GuardSettings,
    removalsToday: number
): BudgetResult {
    if (removalsToday < 0) {
        return {
            needsApproval: true,
            reason: 'removal count for today is invalid',
        };
    }
    const removals = ops.filter(isRemoval).length;
    if (removals > settings.deleteBudgetPerCycle) {
        return {
            needsApproval: true,
            reason: `${removals} removals, over the cycle budget of ${settings.deleteBudgetPerCycle}`,
        };
    }
    if (removalsToday + removals > settings.deleteBudgetPerDay) {
        return {
            needsApproval: true,
            reason: `${removalsToday + removals} removals today, over the daily budget of ${settings.deleteBudgetPerDay}`,
        };
    }
    if (ops.some((op) => op.op === 'hard-delete' && op.adopted)) {
        return {
            needsApproval: true,
            reason: 'hard delete of an adopted object',
        };
    }
    return { needsApproval: false };
}

const KIND_RANK: Readonly<Record<SyncKind, number>> = {
    role: 0,
    category: 1,
    channel: 2,
    emoji: 3,
    sticker: 4,
    // After emojis: a post's first message can use the server's emojis.
    thread: 4.5,
    guild: 5,
};

function rank(op: PlanOp): number {
    if (isRemoval(op)) return 100 + KIND_RANK[op.kind];
    // First-sync updates fit under any write cap, so they are never deferred.
    if (op.op === 'update' && op.baseline) return -1;
    // A link follows every channel write and comes before any thread.
    if (op.op === 'link') return KIND_RANK.channel * 2 + 1.5;
    const reorder = op.op === 'reorder' ? 0.5 : 0;
    return KIND_RANK[op.kind] * 2 + reorder * 2;
}

/**
 * Sorts ops into apply order (design: Cycle steps) and splits off what is
 * over the per-cycle write cap (guard 14). The rest waits for a later cycle.
 */
export function orderAndCap(
    ops: readonly PlanOp[],
    writeCap: number
): { now: PlanOp[]; deferred: PlanOp[] } {
    if (!Number.isInteger(writeCap) || writeCap < 1) {
        return { now: [], deferred: [...ops] };
    }
    const sorted = ops
        .map((op, index) => ({ op, index }))
        .sort((a, b) => rank(a.op) - rank(b.op) || a.index - b.index)
        .map(({ op }) => op);
    return { now: sorted.slice(0, writeCap), deferred: sorted.slice(writeCap) };
}

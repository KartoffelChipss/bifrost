import type { SyncDirection } from '../addons/db/schema';
import type { MissingCopy } from './diff';
import type { GuardSettings } from './guards';
import { presentIds, threadProtected } from './guards';
import { checkSourceHealth, type ShrinkLimits } from './health';
import type { Finding, MapRow, SyncKind } from './ops';
import { destIdOf } from './ops';
import type { GuildSnapshot } from './snapshot';

/**
 * Restores copies the sync created that were deleted on Fluxer. A copy
 * counts as deleted once it is missing from confirmChecks consecutive
 * healthy destination snapshots spanning confirmMinutes (the thresholds
 * removals use), and a direct lookup answers Unknown. Its map row is then
 * forgotten (restoreJob.ts), and the next cycle creates it again through
 * the normal create path: adoption, ordering, write cap, kill switch and
 * mode all apply. Only active rows created by sync while Discord is the
 * source qualify; adopted objects and rows recorded from Fluxer stay
 * findings. This file holds the pure parts.
 */

/** Restores one cycle plans at most. The rest wait for later cycles. */
export const MAX_RESTORES_PER_CYCLE = 10;
/** Restores in any rolling day, counted from the audit log. */
export const MAX_RESTORES_PER_DAY = 50;

const MINUTE_MS = 60_000;

/** The kinds a restore can recreate, in the order restores run. */
export const RESTORABLE_KINDS: readonly SyncKind[] = [
    'role',
    'category',
    'channel',
    'emoji',
    'sticker',
    'thread',
];

export interface DestMissingUpdate {
    readonly rowId: string;
    readonly destMissingCount: number;
    readonly destMissingSince: Date | null;
}

/** One copy a plan restores, with what the summary names it by. */
export interface RestoreItem {
    readonly rowId: string;
    readonly kind: SyncKind;
    readonly discordId: string;
    readonly fluxerId: string;
    readonly name: string;
}

const restorableKind = (kind: MapRow['kind']) =>
    RESTORABLE_KINDS.some((k) => k === kind);

/** The destination parent a thread row's applied fields record, or null. */
function destParent(row: MapRow): string | null {
    const parent = row.appliedFields?.parentId;
    return typeof parent === 'string' ? parent : null;
}

/**
 * True when the destination snapshot is plausible enough to count absence
 * in: the source health checks, applied to the destination. A read that
 * lost @everyone or every channel must never look like deleted copies.
 */
export function destinationHealthy(destination: GuildSnapshot): boolean {
    return checkSourceHealth({ ok: true, snapshot: destination }).ok;
}

/** True for a thread copy whose absence an incomplete list could hide. */
function hiddenThread(row: MapRow, destination: GuildSnapshot): boolean {
    if (row.kind !== 'thread') return false;
    const privateHidden = (destination.privateThreadGaps ?? []).length > 0;
    if (privateHidden && row.appliedFields?.private === true) return true;
    return threadProtected(row, new Set(destination.threadGaps), destParent);
}

/** The counter change for one row, or null when it stays as it is. */
function destMissingFor(
    row: MapRow,
    present: ReadonlySet<string> | undefined,
    destId: string,
    now: Date
): DestMissingUpdate | null {
    if (present?.has(destId)) {
        if (row.destMissingCount === 0 && row.destMissingSince === null) {
            return null;
        }
        return { rowId: row.id, destMissingCount: 0, destMissingSince: null };
    }
    return {
        rowId: row.id,
        destMissingCount: row.destMissingCount + 1,
        destMissingSince: row.destMissingSince ?? now,
    };
}

/**
 * Counts consecutive healthy checks in which each mapped copy was absent
 * from the destination. Run only on a healthy destination snapshot, so a
 * failed read never advances a counter. Returns only rows that change.
 */
export function trackDestMissing(
    rows: readonly MapRow[],
    destination: GuildSnapshot,
    direction: SyncDirection,
    now: Date
): DestMissingUpdate[] {
    const present = presentIds(destination);
    const updates: DestMissingUpdate[] = [];
    for (const row of rows) {
        const destId = destIdOf(row, direction);
        if (row.state !== 'active' || !restorableKind(row.kind)) continue;
        if (!destId || hiddenThread(row, destination)) continue;
        const kind = row.kind as SyncKind;
        const update = destMissingFor(row, present.get(kind), destId, now);
        if (update) updates.push(update);
    }
    return updates;
}

/** Rows whose state after `trackDestMissing` is applied. */
export function applyDestMissing(
    rows: readonly MapRow[],
    updates: readonly DestMissingUpdate[]
): MapRow[] {
    const byId = new Map(updates.map((u) => [u.rowId, u]));
    return rows.map((row) => {
        const update = byId.get(row.id);
        return update ? { ...row, ...update } : row;
    });
}

/** True for an active copy sync created, never @everyone or the guild. */
function copiedBySync(row: MapRow, destination: GuildSnapshot): boolean {
    return (
        row.state === 'active' &&
        row.createdBySync &&
        restorableKind(row.kind) &&
        row.discordId !== null &&
        row.fluxerId !== null &&
        row.fluxerId !== destination.everyoneRoleId &&
        row.fluxerId !== destination.guildId
    );
}

/** True once the count and time thresholds both passed. */
function confirmedMissing(
    row: MapRow,
    settings: GuardSettings,
    now: Date
): boolean {
    if (row.destMissingSince === null) return false;
    const elapsed = now.getTime() - row.destMissingSince.getTime();
    return (
        row.destMissingCount >= settings.confirmChecks &&
        elapsed >= settings.confirmMinutes * MINUTE_MS
    );
}

/**
 * A thread whose parent channel is gone too waits for the channel: the
 * channel's restore forgets it, and alone it could not be created.
 */
function parentGone(row: MapRow, destination: GuildSnapshot): boolean {
    const parent = row.kind === 'thread' ? destParent(row) : null;
    return (
        parent !== null && !destination.channels.some((c) => c.id === parent)
    );
}

const missingKey = (kind: string, sourceId: string, destId: string) =>
    `${kind}:${sourceId}:${destId}`;

/**
 * Rows that passed the count and time parts of the check, sorted into
 * restore order. Each is a copy the diff would sync whose destination is
 * missing (`missing`), so excluded and skipped objects never qualify.
 * Each still needs a direct lookup that answers Unknown.
 */
export function restoreCandidates(
    rows: readonly MapRow[],
    missing: readonly MissingCopy[],
    destination: GuildSnapshot,
    settings: GuardSettings & { readonly direction: SyncDirection },
    now: Date
): MapRow[] {
    if (settings.direction !== 'discord-to-fluxer') return [];
    const keys = new Set(
        missing.map((m) => missingKey(m.kind, m.sourceId, m.destId))
    );
    return rows
        .filter(
            (row) =>
                copiedBySync(row, destination) &&
                keys.has(
                    missingKey(
                        row.kind,
                        row.discordId ?? '',
                        row.fluxerId ?? ''
                    )
                ) &&
                confirmedMissing(row, settings, now) &&
                !parentGone(row, destination)
        )
        .sort(restoreOrder);
}

/** Kind order, then the longest missing first, then by row ID. */
function restoreOrder(a: MapRow, b: MapRow): number {
    const rank = (row: MapRow) =>
        RESTORABLE_KINDS.findIndex((k) => k === row.kind);
    const since = (row: MapRow) => row.destMissingSince?.getTime() ?? 0;
    return (
        rank(a) - rank(b) ||
        since(a) - since(b) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

/** A thread missing only because its parent channel is missing too. */
function followsParent(
    row: MapRow,
    missingChannels: ReadonlySet<string>
): boolean {
    const parent = row.kind === 'thread' ? destParent(row) : null;
    return parent !== null && missingChannels.has(parent);
}

/** Active mapped copies per kind, and how many are missing now. */
function missingPerKind(
    rows: readonly MapRow[]
): Map<SyncKind, { total: number; missing: number }> {
    const active = rows.filter(
        (r) => r.state === 'active' && restorableKind(r.kind) && r.fluxerId
    );
    const missingChannels = new Set(
        active
            .filter((r) => r.kind === 'channel' && r.destMissingCount > 0)
            .map((r) => r.fluxerId ?? '')
    );
    const counts = new Map<SyncKind, { total: number; missing: number }>();
    for (const row of active) {
        const entry = counts.get(row.kind as SyncKind) ?? {
            total: 0,
            missing: 0,
        };
        entry.total += 1;
        if (row.destMissingCount > 0 && !followsParent(row, missingChannels)) {
            entry.missing += 1;
        }
        counts.set(row.kind as SyncKind, entry);
    }
    return counts;
}

/**
 * The mass-disappearance check: why nothing may be restored, or null.
 * Trips when the copies of one kind missing on Fluxer right now exceed
 * the larger of shrinkPercent of that kind's mapped copies and
 * shrinkMinObjects, the limits of the source shrink check (guard 3).
 * Threads missing only because their channel is missing do not count.
 */
export function massMissing(
    rows: readonly MapRow[],
    limits: ShrinkLimits
): string | null {
    if (limits.shrinkPercent < 1 || limits.shrinkPercent > 100) {
        return 'restore check: shrinkPercent is out of range';
    }
    if (limits.shrinkMinObjects < 0) {
        return 'restore check: shrinkMinObjects is negative';
    }
    for (const [kind, { total, missing }] of missingPerKind(rows)) {
        const allowed = Math.max(
            Math.floor((total * limits.shrinkPercent) / 100),
            limits.shrinkMinObjects
        );
        if (missing > allowed) {
            return `${missing} of ${total} ${kind} copies are missing on Fluxer at once, over the limit of ${allowed}: nothing is recreated until an admin approves`;
        }
    }
    return null;
}

/**
 * How many restores this cycle may plan: the per-cycle cap, less what the
 * daily cap has left. Zero with a reason when the day is used up.
 */
export function restoreRoom(restoresToday: number): {
    room: number;
    reason: string | null;
} {
    if (!Number.isInteger(restoresToday) || restoresToday < 0) {
        return { room: 0, reason: 'restore count for today is invalid' };
    }
    const left = MAX_RESTORES_PER_DAY - restoresToday;
    if (left <= 0) {
        return {
            room: 0,
            reason: `${restoresToday} copies restored today, the daily cap of ${MAX_RESTORES_PER_DAY}`,
        };
    }
    return { room: Math.min(MAX_RESTORES_PER_CYCLE, left), reason: null };
}

/** The plan entry for one confirmed row. */
export function restoreItem(row: MapRow, name: string): RestoreItem {
    return {
        rowId: row.id,
        kind: row.kind as SyncKind,
        discordId: row.discordId ?? '',
        fluxerId: row.fluxerId ?? '',
        name,
    };
}

/** The finding a planned restore shows in the plan and the status. */
export function restoreFinding(item: RestoreItem): Finding {
    return {
        type: 'restore',
        kind: item.kind,
        id: item.fluxerId,
        detail: `"${item.name}" was deleted on Fluxer and will be recreated (from ${item.discordId})`,
    };
}

/** A finding for restores that wait, with why. */
export function heldFinding(
    kind: SyncKind,
    id: string,
    detail: string
): Finding {
    return { type: 'restore-held', kind, id, detail };
}

/**
 * The restores an apply run may carry out. Normally every planned one.
 * While the mass check holds them, only those an admin approved: the
 * approved plan was held too and listed the same rows.
 */
export function allowedRestores(
    planned: readonly RestoreItem[],
    hold: string | null,
    approved: {
        readonly restores?: readonly RestoreItem[];
        readonly restoreHold?: string | null;
    } | null
): RestoreItem[] {
    if (hold === null) return [...planned];
    if (!approved?.restoreHold) return [];
    const ok = new Set((approved.restores ?? []).map((r) => r.rowId));
    return planned.filter((r) => ok.has(r.rowId));
}

/** Thread copies that sync created in a channel, by map row. */
export function childThreads(
    rows: readonly MapRow[],
    channel: RestoreItem,
    source: GuildSnapshot
): MapRow[] {
    const parents = new Map(source.threads.map((t) => [t.id, t.parentId]));
    return rows.filter(
        (row) =>
            row.kind === 'thread' &&
            row.state === 'active' &&
            row.createdBySync &&
            row.discordId !== null &&
            row.fluxerId !== null &&
            (destParent(row) === channel.fluxerId ||
                parents.get(row.discordId) === channel.discordId)
    );
}

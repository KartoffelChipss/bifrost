import type { AddonLogger } from '../addons/isolation';
import type { MissingCopy } from './diff';
import type { ChannelLinker } from './links';
import type { Finding, MapRow } from './ops';
import type { GuildReader } from './readers/reader';
import {
    MAX_RESTORES_PER_CYCLE,
    childThreads,
    heldFinding,
    massMissing,
    restoreCandidates,
    restoreFinding,
    restoreItem,
    restoreRoom,
    type RestoreItem,
} from './restore';
import type { GuildSnapshot } from './snapshot';
import {
    HISTORY_LOCK_KEY,
    type GuildSyncStore,
    type RestoreTarget,
    type SyncSettings,
} from './store';

/**
 * The I/O half of restoring copies deleted on Fluxer (restore.ts has the
 * rules). planRestores runs while a cycle plans, in every mode: it reads
 * the daily count and looks each candidate up. runRestores runs in apply
 * mode only, after the plan was applied: it forgets the rows, so the next
 * cycle creates the copies again.
 */

const DAY_MS = 24 * 60 * 60_000;

/** What a cycle plans to restore. */
export interface RestorePlan {
    readonly restores: RestoreItem[];
    readonly findings: Finding[];
    /** Why the restores wait for an admin (the mass check), or null. */
    readonly hold: string | null;
}

export const NO_RESTORES: RestorePlan = {
    restores: [],
    findings: [],
    hold: null,
};

export interface RestorePlanInput {
    readonly guildLinkId: string;
    readonly fluxerGuildId: string;
    readonly settings: SyncSettings;
    readonly rows: readonly MapRow[];
    readonly missing: readonly MissingCopy[];
    readonly destination: GuildSnapshot;
    readonly now: Date;
}

export interface RestorePlanDeps {
    readonly store: Pick<GuildSyncStore, 'restoresSince'>;
    /** The Fluxer reader, for the direct lookups. */
    readonly reader: GuildReader;
}

/** Findings for candidates over this cycle's room. */
function capFindings(
    input: RestorePlanInput,
    waiting: number,
    reason: string | null
): Finding[] {
    if (waiting <= 0) return [];
    const detail = reason
        ? `${waiting} copies deleted on Fluxer wait: ${reason}`
        : `${waiting} more copies deleted on Fluxer wait for later cycles: at most ${MAX_RESTORES_PER_CYCLE} are restored per cycle`;
    return [heldFinding('guild', input.destination.guildId, detail)];
}

/** Looks each row up; only rows Fluxer answers Unknown for are planned. */
async function confirmBatch(
    input: RestorePlanInput,
    batch: readonly MapRow[],
    reader: GuildReader
): Promise<{ restores: RestoreItem[]; findings: Finding[] }> {
    const names = new Map(
        input.missing.map((m) => [`${m.kind}:${m.sourceId}`, m.name])
    );
    const restores: RestoreItem[] = [];
    const findings: Finding[] = [];
    for (const row of batch.slice(0, MAX_RESTORES_PER_CYCLE)) {
        const name = names.get(`${row.kind}:${row.discordId}`) ?? '';
        const item = restoreItem(row, name);
        const gone = await reader.isGone(
            input.fluxerGuildId,
            item.kind,
            item.fluxerId
        );
        if (gone === true) {
            restores.push(item);
            continue;
        }
        findings.push(
            heldFinding(
                item.kind,
                item.fluxerId,
                'missing from the Fluxer snapshot, but a direct lookup did not confirm it is gone'
            )
        );
    }
    return { restores, findings };
}

/**
 * The restores this cycle plans: confirmed candidates within the caps,
 * each looked up. With the mass check tripped they are still listed, so
 * an admin sees what an approval would restore, but `hold` is set.
 */
export async function planRestores(
    input: RestorePlanInput,
    deps: RestorePlanDeps
): Promise<RestorePlan> {
    const { settings, rows, now } = input;
    const candidates = restoreCandidates(
        rows,
        input.missing,
        input.destination,
        settings,
        now
    );
    if (candidates.length === 0) return NO_RESTORES;
    const hold = massMissing(rows, settings);
    const today = await deps.store.restoresSince(
        input.guildLinkId,
        new Date(now.getTime() - DAY_MS)
    );
    const { room, reason } = restoreRoom(today);
    const batch = candidates.slice(0, room);
    const confirmed = await confirmBatch(input, batch, deps.reader);
    const findings = [
        ...confirmed.restores.map(restoreFinding),
        ...confirmed.findings,
        ...capFindings(input, candidates.length - batch.length, reason),
    ];
    if (hold)
        findings.push(heldFinding('guild', input.destination.guildId, hold));
    return { restores: confirmed.restores, findings, hold };
}

/** How a restore run went. */
export interface RestoreResult {
    restored: number;
    /** The lookup no longer answered Unknown: left as it is. */
    notConfirmed: number;
    /** The map row was no longer the same active copy: left as it is. */
    changed: number;
    failed: number;
    /** Why the run stopped early, or null. */
    stopped: string | null;
}

export interface RestoreRunDeps {
    readonly store: Pick<
        GuildSyncStore,
        'withLeaderLock' | 'loadObjectMap' | 'restoreCopy'
    >;
    /** The Fluxer reader, for the lookup right before each restore. */
    readonly reader: GuildReader;
    /** Bifröst's channel links, or null when the relay is not wired in. */
    readonly links: ChannelLinker | null;
    /** Why writes must stop now (kill switch, mode), or null. */
    readonly writesStopped: () => Promise<string | null>;
    /** False once the guild-sync leader lock is lost. */
    readonly stillLeader?: () => Promise<boolean>;
    /** Names this process in a lock row. */
    readonly holder: string;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

export interface RestoreRunInput {
    readonly guildLinkId: string;
    readonly fluxerGuildId: string;
    readonly items: readonly RestoreItem[];
    /** The plan's ID: it groups the audit rows. */
    readonly runId: string;
    /** The Discord snapshot, for the threads of a restored channel. */
    readonly source: GuildSnapshot;
}

function newResult(): RestoreResult {
    return {
        restored: 0,
        notConfirmed: 0,
        changed: 0,
        failed: 0,
        stopped: null,
    };
}

/**
 * Forgets the rows of the planned restores. It holds the history lock,
 * so no history pass imports into a copy while its history job is reset;
 * when a pass holds it, the restores wait for the next cycle.
 */
export async function runRestores(
    input: RestoreRunInput,
    deps: RestoreRunDeps
): Promise<RestoreResult> {
    const result = newResult();
    if (input.items.length === 0) return result;
    const locked = await deps.store.withLeaderLock(
        deps.holder,
        () => restoreEach(input, deps, result),
        HISTORY_LOCK_KEY
    );
    if (!locked.ran) {
        result.stopped =
            'a history pass is running; the restores wait for the next cycle';
    }
    logResult(input, result, deps.logger);
    return result;
}

function logResult(
    input: RestoreRunInput,
    result: RestoreResult,
    logger: AddonLogger
): void {
    const text = `Restores for link ${input.guildLinkId}: ${result.restored} forgotten for recreation, ${result.notConfirmed} not confirmed gone, ${result.changed} changed, ${result.failed} failed`;
    const stopped = result.stopped ? `; stopped: ${result.stopped}` : '';
    if (result.failed > 0 || result.stopped) {
        logger.warn(`[guild-sync] ${text}${stopped}`);
    } else logger.info(`[guild-sync] ${text}`);
}

/** Why the run must stop before the next restore, or null. */
async function whyStop(deps: RestoreRunDeps): Promise<string | null> {
    if (deps.stillLeader && !(await deps.stillLeader())) {
        return 'the leader lock was lost';
    }
    return deps.writesStopped();
}

async function restoreEach(
    input: RestoreRunInput,
    deps: RestoreRunDeps,
    result: RestoreResult
): Promise<void> {
    const rows = await deps.store.loadObjectMap(input.guildLinkId);
    for (const item of input.items.slice(0, MAX_RESTORES_PER_CYCLE)) {
        const reason = await whyStop(deps);
        if (reason) {
            result.stopped = reason;
            return;
        }
        const outcome = await restoreOne(input, item, rows, deps);
        result[outcome] += 1;
        if (outcome === 'failed') {
            result.stopped = 'a restore failed';
            return;
        }
    }
}

type Outcome = 'restored' | 'notConfirmed' | 'changed' | 'failed';

/** True when the row is still the active copy the plan named. */
function stillSame(rows: readonly MapRow[], item: RestoreItem): boolean {
    const row = rows.find((r) => r.id === item.rowId);
    return (
        row?.kind === item.kind &&
        row.state === 'active' &&
        row.createdBySync &&
        row.discordId === item.discordId &&
        row.fluxerId === item.fluxerId
    );
}

/** The store target for one item, with a channel's thread copies. */
function targetFor(
    item: RestoreItem,
    rows: readonly MapRow[],
    source: GuildSnapshot
): RestoreTarget {
    const threads =
        item.kind === 'channel'
            ? childThreads(rows, item, source).map((row) => ({
                  rowId: row.id,
                  discordId: row.discordId ?? '',
                  fluxerId: row.fluxerId ?? '',
              }))
            : [];
    return {
        rowId: item.rowId,
        kind: item.kind,
        discordId: item.discordId,
        fluxerId: item.fluxerId,
        threads,
    };
}

/**
 * Looks the copy up once more, unlinks a channel's relay bridge (its
 * Fluxer webhook went with the channel), then forgets the row. The
 * bridge goes first: a row forgotten with the bridge left would leave
 * the new channel unbridged for good, while a bridge removed with the
 * row left is restored again next cycle.
 */
async function restoreOne(
    input: RestoreRunInput,
    item: RestoreItem,
    rows: readonly MapRow[],
    deps: RestoreRunDeps
): Promise<Outcome> {
    if (!stillSame(rows, item)) return 'changed';
    const gone = await deps.reader.isGone(
        input.fluxerGuildId,
        item.kind,
        item.fluxerId
    );
    if (gone !== true) return 'notConfirmed';
    try {
        if (item.kind === 'channel') await deps.links?.unlink(item.discordId);
        const cleared = await deps.store.restoreCopy(
            input.guildLinkId,
            targetFor(item, rows, input.source),
            input.runId,
            deps.now()
        );
        return cleared.mapRows > 0 ? 'restored' : 'changed';
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.logger.warn(
            `[guild-sync] Could not restore ${item.kind} ${item.fluxerId}: ${detail}`
        );
        return 'failed';
    }
}

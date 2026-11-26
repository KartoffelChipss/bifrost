import { randomUUID } from 'node:crypto';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
    OBJECT_KINDS,
    OBJECT_STATES,
    PLAN_STATUSES,
    SYNC_DIRECTIONS,
    SYNC_MODES,
    TABLES,
    type ObjectKind,
    type ObjectState,
    type PlanStatus,
    type SnapshotSide,
    type SyncDirection,
    type SyncMode,
} from '../addons/db/schema';
import type { MissingUpdate, GuardSettings } from './guards';
import type { ShrinkLimits } from './health';
import { MAX_INTENTS, type CreateIntent } from './adopt';
import type { JsonValue, MapRow, SyncKind } from './ops';
import type { Plan, PlanBody } from './plan';
import type { GuildSnapshot } from './snapshot';
import { countObjects } from './snapshot';

/** `addon_settings` for one guild link. */
export interface SyncSettings extends GuardSettings, ShrinkLimits {
    readonly mode: SyncMode;
    readonly direction: SyncDirection;
    readonly killSwitch: boolean;
    /** The source-side channel for plans and admin commands, if set. */
    readonly adminChannelId: string | null;
    /** The pending plan an admin approved. Used once, then cleared. */
    readonly approvedPlanId: string | null;
    /** Revert Fluxer edits to managed fields instead of reporting drift. */
    readonly enforceDrift: boolean;
}

type AppliedFields = Readonly<Record<string, JsonValue>>;

/** Where guild-sync's live status message for a link was posted. */
export interface StatusMessageRef {
    readonly channelId: string;
    readonly messageId: string;
}

/** Active object map rows, by kind. A kind with no rows is absent. */
export type MappedCounts = Readonly<Partial<Record<ObjectKind, number>>>;

/** A new `addon_object_map` row. */
export interface NewMapping {
    readonly guildLinkId: string;
    readonly kind: ObjectKind;
    /** Null on the source side for an object with no source (archive category). */
    readonly discordId: string | null;
    readonly fluxerId: string | null;
    /** False for an object that existed before, such as @everyone. */
    readonly createdBySync: boolean;
    readonly appliedFields: AppliedFields;
}

/** One `addon_audit_log` row: a write that was attempted. */
export interface AuditEntry {
    readonly planId: string;
    readonly guildLinkId: string;
    readonly op: string;
    readonly kind: ObjectKind;
    readonly sourceId: string | null;
    readonly destId: string | null;
    readonly before: JsonValue | null;
    readonly after: JsonValue | null;
    /**
     * 'intent' marks a create about to be sent, and 'refused' a create the
     * platform then refused outright (adopt.ts).
     */
    readonly result: 'ok' | 'failed' | 'intent' | 'refused';
}

/** The two copies of one message relayed inside a thread. */
export interface ThreadMessage {
    readonly guildLinkId: string;
    readonly discordThreadId: string;
    readonly fluxerThreadId: string;
    readonly discordMessageId: string;
    readonly fluxerMessageId: string;
}

/** The database access the thread relay needs. */
export interface ThreadRelayStore {
    /** The active thread pair that holds this thread, on either side. */
    findThreadPair(
        side: SnapshotSide,
        threadId: string
    ): Promise<{
        guildLinkId: string;
        discordId: string;
        fluxerId: string;
    } | null>;
    saveThreadMessage(message: ThreadMessage, now: Date): Promise<void>;
    findThreadMessage(
        side: SnapshotSide,
        messageId: string
    ): Promise<ThreadMessage | null>;
    deleteThreadMessage(side: SnapshotSide, messageId: string): Promise<void>;
    /**
     * True when history import copied this Discord reply, or covered it:
     * it is at or before the cutoff of the thread's finished history job.
     */
    historyCovers?(
        discordThreadId: string,
        discordMessageId: string
    ): Promise<boolean>;
}

/** The database access one cycle needs. The cycle depends only on this. */
export interface GuildSyncStore {
    /**
     * Runs `fn` while holding a leader lock (guard 12), or not at all. Each
     * add-on loop uses its own key, so they never wait on one another.
     * `fn` gets a check that the lock is still held, for long runs.
     */
    withLeaderLock<T>(
        holder: string,
        fn: (held: () => Promise<boolean>) => Promise<T>,
        key?: number
    ): Promise<{ ran: true; value: T } | { ran: false }>;
    loadSettings(guildLinkId: string): Promise<SyncSettings>;
    loadObjectMap(guildLinkId: string): Promise<MapRow[]>;
    lastSnapshot(
        guildLinkId: string,
        side: SnapshotSide,
        healthyOnly: boolean
    ): Promise<GuildSnapshot | null>;
    saveSnapshot(
        guildLinkId: string,
        snapshot: GuildSnapshot,
        healthy: boolean,
        takenAt: Date
    ): Promise<void>;
    saveMissing(updates: readonly MissingUpdate[], now: Date): Promise<void>;
    savePlan(plan: Plan, now: Date): Promise<void>;
    removalsSince(guildLinkId: string, since: Date): Promise<number>;
    pruneSnapshots(before: Date): Promise<void>;
    /**
     * Deletes plans saved before `before`, keeping per link the newest
     * PLANS_KEPT_PER_LINK plans and the newest pending-approval plan, and
     * the plan an admin approved. Returns how many went.
     */
    prunePlans(before: Date): Promise<number>;
    /** Create intents recorded since `since`, newest first, bounded. */
    createIntents(guildLinkId: string, since: Date): Promise<CreateIntent[]>;
    /**
     * Deletes tombstoned map rows. A row is tombstoned only once its
     * destination object is confirmed deleted, so nothing reads it again;
     * the audit log keeps the record.
     */
    pruneTombstoned(before: Date): Promise<number>;
    /** Records ownership of a destination object (guard 1). */
    insertMapping(mapping: NewMapping, now: Date): Promise<MapRow>;
    /** Records the fields a successful update wrote. */
    saveApplied(rowId: string, fields: AppliedFields, now: Date): Promise<void>;
    audit(entry: AuditEntry, now: Date): Promise<void>;
    setPlanStatus(
        planId: string,
        status: PlanStatus,
        abortReason: string | null,
        now: Date
    ): Promise<void>;
    setMode(guildLinkId: string, mode: SyncMode, now: Date): Promise<void>;
    setKillSwitch(guildLinkId: string, on: boolean, now: Date): Promise<void>;
    setEnforceDrift(guildLinkId: string, on: boolean, now: Date): Promise<void>;
    setAdminChannel(
        guildLinkId: string,
        channelId: string | null,
        now: Date
    ): Promise<void>;
    /** Stores or clears the one plan an admin approved. */
    setApprovedPlan(
        guildLinkId: string,
        planId: string | null,
        now: Date
    ): Promise<void>;
    /** Marks a map row archived or tombstoned after a removal. */
    setRowState(rowId: string, state: ObjectState, now: Date): Promise<void>;
    lastPlan(guildLinkId: string): Promise<Plan | null>;
    getPlan(planId: string): Promise<Plan | null>;
    /** The saved status message, or null before the first one is posted. */
    loadStatusMessage(guildLinkId: string): Promise<StatusMessageRef | null>;
    /** Saves or clears the status message's place. */
    saveStatusMessage(
        guildLinkId: string,
        ref: StatusMessageRef | null
    ): Promise<void>;
    /** Active object map rows by kind, for the status message. */
    countMapped(guildLinkId: string): Promise<MappedCounts>;
}

/** Arbitrary constant: 'bfsg' in ASCII. Shared by every fork instance. */
export const LEADER_LOCK_KEY = 0x62667367;
/** 'bfhi': the history import loop. */
export const HISTORY_LOCK_KEY = 0x62666869;
/** 'bfid': the account-linking role sweep. */
export const IDENTITY_LOCK_KEY = 0x62666964;

export class StoreDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StoreDataError';
    }
}

type Row = Record<string, unknown>;

function oneOf<T extends string>(
    values: readonly T[],
    value: unknown,
    field: string
): T {
    const match = values.find((candidate) => candidate === value);
    if (match === undefined) {
        throw new StoreDataError(`${field} has an unknown value`);
    }
    return match;
}

function int(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new StoreDataError(`${field} is not an integer`);
    }
    return value;
}

function optionalId(value: unknown, field: string): string | null {
    if (value === null) return null;
    if (typeof value !== 'string')
        throw new StoreDataError(`${field} is not a string`);
    return value;
}

/** Parses an `addon_settings` row. Rows are validated, not trusted. */
export function parseSettings(row: Row): SyncSettings {
    if (typeof row.killSwitch !== 'boolean') {
        throw new StoreDataError('killSwitch is not a boolean');
    }
    if (typeof row.enforceDrift !== 'boolean') {
        throw new StoreDataError('enforceDrift is not a boolean');
    }
    return {
        mode: oneOf(SYNC_MODES, row.mode, 'mode'),
        direction: oneOf(SYNC_DIRECTIONS, row.direction, 'direction'),
        killSwitch: row.killSwitch,
        enforceDrift: row.enforceDrift,
        adminChannelId: optionalId(
            row.adminChannelId ?? null,
            'adminChannelId'
        ),
        approvedPlanId: optionalId(
            row.approvedPlanId ?? null,
            'approvedPlanId'
        ),
        shrinkPercent: int(row.shrinkPercent, 'shrinkPercent'),
        shrinkMinObjects: int(row.shrinkMinObjects, 'shrinkMinObjects'),
        confirmChecks: int(row.confirmChecks, 'confirmChecks'),
        confirmMinutes: int(row.confirmMinutes, 'confirmMinutes'),
        gracePeriodDays: int(row.gracePeriodDays, 'gracePeriodDays'),
        deleteBudgetPerCycle: int(
            row.deleteBudgetPerCycle,
            'deleteBudgetPerCycle'
        ),
        deleteBudgetPerDay: int(row.deleteBudgetPerDay, 'deleteBudgetPerDay'),
        writeCapPerCycle: int(row.writeCapPerCycle, 'writeCapPerCycle'),
    };
}

/** Parses an `addon_object_map` row. */
export function parseMapRow(row: Row): MapRow {
    if (typeof row.id !== 'string' || typeof row.createdBySync !== 'boolean') {
        throw new StoreDataError('object map row is malformed');
    }
    const missingSince = row.missingSince;
    if (missingSince !== null && !(missingSince instanceof Date)) {
        throw new StoreDataError('missingSince is not a date');
    }
    return {
        id: row.id,
        kind: oneOf(OBJECT_KINDS, row.kind, 'kind'),
        discordId: optionalId(row.discordId, 'discordId'),
        fluxerId: optionalId(row.fluxerId, 'fluxerId'),
        state: oneOf(OBJECT_STATES, row.state, 'state'),
        createdBySync: row.createdBySync,
        missingSince,
        missingCount: int(row.missingCount, 'missingCount'),
        appliedFields: parseApplied(row.appliedFields),
    };
}

/** `appliedFields` is NULL or a JSON object. Only the fork writes it. */
function parseApplied(value: unknown): AppliedFields | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new StoreDataError('appliedFields is not an object');
    }
    return value as AppliedFields;
}

const PLAN_LISTS = ['ops', 'deferred', 'findings'] as const;

/** Parses an `addon_plans` row. The body is checked at its top level. */
export function parsePlan(row: Row): Plan {
    const body = row.ops;
    if (
        typeof row.id !== 'string' ||
        typeof row.guildLinkId !== 'string' ||
        typeof body !== 'object' ||
        body === null
    ) {
        throw new StoreDataError('plan row is malformed');
    }
    for (const key of PLAN_LISTS) {
        if (!Array.isArray((body as Row)[key])) {
            throw new StoreDataError(`plan body has no ${key} list`);
        }
    }
    return {
        id: row.id,
        guildLinkId: row.guildLinkId,
        direction: oneOf(SYNC_DIRECTIONS, row.direction, 'direction'),
        status: oneOf(PLAN_STATUSES, row.status, 'status'),
        body: body as PlanBody,
        abortReason: optionalId(row.abortReason, 'abortReason'),
    };
}

const SNAPSHOT_ARRAYS = ['roles', 'channels', 'emojis', 'stickers'] as const;

/**
 * Checks the top-level shape of a stored snapshot. Only the fork writes
 * this column, so a shallow check catches corruption and old formats.
 */
export function parseSnapshot(payload: unknown): GuildSnapshot {
    if (typeof payload !== 'object' || payload === null) {
        throw new StoreDataError('snapshot payload is not an object');
    }
    const snap = payload as Row;
    if (
        typeof snap.guildId !== 'string' ||
        typeof snap.everyoneRoleId !== 'string'
    ) {
        throw new StoreDataError('snapshot payload has no guild IDs');
    }
    for (const key of SNAPSHOT_ARRAYS) {
        if (!Array.isArray(snap[key])) {
            throw new StoreDataError(`snapshot payload has no ${key} list`);
        }
    }
    // Snapshots saved before threads and forum tags lack those fields.
    const channels = (snap.channels as Row[]).map((channel) =>
        Array.isArray(channel.tags) ? channel : { ...channel, tags: [] }
    );
    return {
        ...snap,
        channels,
        threads: Array.isArray(snap.threads) ? snap.threads : [],
        threadGaps: Array.isArray(snap.threadGaps) ? snap.threadGaps : [],
    } as unknown as GuildSnapshot;
}

/** Plans kept per link however old: `sync status` and debugging use them. */
export const PLANS_KEPT_PER_LINK = 20;

/**
 * Upper bound on map rows per guild link: roles, channels, expressions and
 * every synced thread and forum post, which is where most rows come from.
 */
export const MAX_MAP_ROWS = 100_000;

/**
 * The object map is over MAX_MAP_ROWS. Only that link's cycle stops: it is
 * a size limit, not corrupt data, so the add-ons stay in their mode.
 */
export class MapTooLargeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MapTooLargeError';
    }
}

/** A create-intent audit row, or nothing when it is malformed. */
function parseIntent(row: Row): CreateIntent[] {
    const after = row.after as { name?: unknown; refused?: unknown } | null;
    const kind = OBJECT_KINDS.find((k) => k === row.kind);
    if (
        !kind ||
        kind === 'overwrite' ||
        typeof row.sourceId !== 'string' ||
        typeof after?.name !== 'string' ||
        !(row.at instanceof Date)
    ) {
        return [];
    }
    return [
        {
            kind: kind as SyncKind,
            sourceId: row.sourceId,
            name: after.name,
            at: row.at,
            refused: after.refused === true,
        },
    ];
}

/** A status message reference from a settings row, or null. */
export function parseStatusMessage(row: Row): StatusMessageRef | null {
    const channelId = optionalId(
        row.statusChannelId ?? null,
        'statusChannelId'
    );
    const messageId = optionalId(
        row.statusMessageId ?? null,
        'statusMessageId'
    );
    return channelId && messageId ? { channelId, messageId } : null;
}

/** Map row counts by kind, from `SELECT kind, count(*)` rows. */
export function parseMappedCounts(rows: readonly Row[]): MappedCounts {
    const counts: Partial<Record<ObjectKind, number>> = {};
    for (const row of rows.slice(0, OBJECT_KINDS.length)) {
        const kind = oneOf(OBJECT_KINDS, row.kind, 'kind');
        // count() is bigint, which pg returns as text.
        const count = Number(row.count);
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new StoreDataError('map row count is not a count');
        }
        counts[kind] = count;
    }
    return counts;
}

/** Rows a DELETE removed, from the pg result Sequelize passes back. */
function rowCount(meta: unknown): number {
    const count = (meta as { rowCount?: unknown } | null)?.rowCount;
    return typeof count === 'number' ? count : 0;
}

/** {@link GuildSyncStore} on the fork's Postgres database. */
export class PostgresGuildSyncStore
    implements GuildSyncStore, ThreadRelayStore
{
    constructor(private readonly db: Sequelize) {
        if (db.getDialect() !== 'postgres') {
            throw new StoreDataError('guild-sync needs Postgres');
        }
    }

    async withLeaderLock<T>(
        holder: string,
        fn: (held: () => Promise<boolean>) => Promise<T>,
        key = LEADER_LOCK_KEY
    ): Promise<{ ran: true; value: T } | { ran: false }> {
        // A transaction-scoped advisory lock is released on commit, on
        // rollback and when the connection dies, so it never goes stale.
        return this.db.transaction(async (transaction) => {
            // The lock lives on this transaction's connection. If that
            // connection is gone, so is the lock, and writes must stop.
            const held = () =>
                this.db
                    .query('SELECT 1', { type: QueryTypes.SELECT, transaction })
                    .then(
                        () => true,
                        () => false
                    );
            const [row] = await this.db.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_xact_lock($1) AS locked',
                {
                    bind: [key],
                    type: QueryTypes.SELECT,
                    transaction,
                }
            );
            if (!row?.locked) return { ran: false as const };
            if (key !== LEADER_LOCK_KEY) {
                return { ran: true as const, value: await fn(held) };
            }
            await this.db.query(
                `INSERT INTO ${TABLES.leaderLock} (id, holder, "acquiredAt", "heartbeatAt") VALUES (1, $1, now(), now())
                 ON CONFLICT (id) DO UPDATE SET holder = $1, "acquiredAt" = now(), "heartbeatAt" = now()`,
                { bind: [holder] }
            );
            return { ran: true as const, value: await fn(held) };
        });
    }

    async loadSettings(guildLinkId: string): Promise<SyncSettings> {
        // Insert-if-missing keeps the defaults in one place: the migration.
        await this.db.query(
            `INSERT INTO ${TABLES.settings} ("guildLinkId", "updatedAt") VALUES ($1, now()) ON CONFLICT ("guildLinkId") DO NOTHING`,
            { bind: [guildLinkId] }
        );
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.settings} WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId], type: QueryTypes.SELECT }
        );
        if (rows.length !== 1)
            throw new StoreDataError('settings row is missing');
        return parseSettings(rows[0]);
    }

    async loadObjectMap(guildLinkId: string): Promise<MapRow[]> {
        const rows = await this.db.query<Row>(
            `SELECT id, kind, "discordId", "fluxerId", state, "createdBySync", "missingSince", "missingCount", "appliedFields"
             FROM ${TABLES.objectMap} WHERE "guildLinkId" = $1 ORDER BY id LIMIT $2`,
            { bind: [guildLinkId, MAX_MAP_ROWS + 1], type: QueryTypes.SELECT }
        );
        if (rows.length > MAX_MAP_ROWS) {
            throw new MapTooLargeError(
                `object map has over ${MAX_MAP_ROWS} rows`
            );
        }
        return rows.map(parseMapRow);
    }

    async lastSnapshot(
        guildLinkId: string,
        side: SnapshotSide,
        healthyOnly: boolean
    ): Promise<GuildSnapshot | null> {
        const rows = await this.db.query<{ payload: unknown }>(
            `SELECT payload FROM ${TABLES.snapshots}
             WHERE "guildLinkId" = $1 AND side = $2 AND (healthy OR NOT $3)
             ORDER BY "takenAt" DESC LIMIT 1`,
            { bind: [guildLinkId, side, healthyOnly], type: QueryTypes.SELECT }
        );
        return rows.length === 0 ? null : parseSnapshot(rows[0].payload);
    }

    async saveSnapshot(
        guildLinkId: string,
        snapshot: GuildSnapshot,
        healthy: boolean,
        takenAt: Date
    ): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.snapshots} (id, "guildLinkId", side, "takenAt", healthy, "objectCounts", payload)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
            {
                bind: [
                    randomUUID(),
                    guildLinkId,
                    snapshot.side,
                    takenAt,
                    healthy,
                    JSON.stringify(countObjects(snapshot)),
                    JSON.stringify(snapshot),
                ],
            }
        );
    }

    async saveMissing(
        updates: readonly MissingUpdate[],
        now: Date
    ): Promise<void> {
        if (updates.length === 0) return;
        await this.db.transaction(async (transaction) => {
            for (const update of updates) {
                await this.db.query(
                    `UPDATE ${TABLES.objectMap} SET "missingCount" = $2, "missingSince" = $3, "updatedAt" = $4 WHERE id = $1`,
                    {
                        bind: [
                            update.rowId,
                            update.missingCount,
                            update.missingSince,
                            now,
                        ],
                        transaction,
                    }
                );
            }
        });
    }

    async savePlan(plan: Plan, now: Date): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.plans} (id, "guildLinkId", direction, status, ops, "abortReason", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)`,
            {
                bind: [
                    plan.id,
                    plan.guildLinkId,
                    plan.direction,
                    plan.status,
                    JSON.stringify(plan.body),
                    plan.abortReason,
                    now,
                ],
            }
        );
    }

    async removalsSince(guildLinkId: string, since: Date): Promise<number> {
        const [row] = await this.db.query<{ count: string }>(
            `SELECT count(*) AS count FROM ${TABLES.auditLog}
             WHERE "guildLinkId" = $1 AND op IN ('archive', 'hard-delete') AND result = 'ok' AND at >= $2`,
            { bind: [guildLinkId, since], type: QueryTypes.SELECT }
        );
        const count = Number(row?.count);
        if (!Number.isInteger(count))
            throw new StoreDataError('removal count is not a number');
        return count;
    }

    async pruneSnapshots(before: Date): Promise<void> {
        // Keeps the newest healthy snapshot per side: the shrink check and
        // a restore both need it, however old it is.
        await this.db.query(
            `DELETE FROM ${TABLES.snapshots} WHERE "takenAt" < $1 AND id NOT IN (
                SELECT DISTINCT ON ("guildLinkId", side) id FROM ${TABLES.snapshots}
                WHERE healthy ORDER BY "guildLinkId", side, "takenAt" DESC)`,
            { bind: [before] }
        );
    }

    async createIntents(
        guildLinkId: string,
        since: Date
    ): Promise<CreateIntent[]> {
        const rows = await this.db.query<Row>(
            `SELECT kind, "sourceId", after, at FROM ${TABLES.auditLog}
             WHERE "guildLinkId" = $1 AND op = 'create-intent' AND at >= $2
             ORDER BY at DESC LIMIT $3`,
            { bind: [guildLinkId, since, MAX_INTENTS], type: QueryTypes.SELECT }
        );
        return rows.flatMap(parseIntent);
    }

    async prunePlans(before: Date): Promise<number> {
        const [, meta] = await this.db.query(
            `DELETE FROM ${TABLES.plans} WHERE "createdAt" < $1
               AND id NOT IN (
                 SELECT "approvedPlanId" FROM ${TABLES.settings}
                 WHERE "approvedPlanId" IS NOT NULL)
               AND id NOT IN (
                 SELECT id FROM (
                   SELECT id, row_number() OVER (
                     PARTITION BY "guildLinkId" ORDER BY "createdAt" DESC) AS n
                   FROM ${TABLES.plans}) ranked
                 WHERE n <= $2)
               AND id NOT IN (
                 SELECT DISTINCT ON ("guildLinkId") id FROM ${TABLES.plans}
                 WHERE status = 'pending-approval'
                 ORDER BY "guildLinkId", "createdAt" DESC)`,
            { bind: [before, PLANS_KEPT_PER_LINK] }
        );
        return rowCount(meta);
    }

    async pruneTombstoned(before: Date): Promise<number> {
        const [, meta] = await this.db.query(
            `DELETE FROM ${TABLES.objectMap} WHERE state = 'tombstoned' AND "updatedAt" < $1`,
            { bind: [before] }
        );
        return rowCount(meta);
    }

    async insertMapping(mapping: NewMapping, now: Date): Promise<MapRow> {
        const id = randomUUID();
        await this.db.query(
            `INSERT INTO ${TABLES.objectMap} (id, "guildLinkId", kind, "discordId", "fluxerId", state, "createdBySync", "appliedFields", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $7::jsonb, $8, $8)`,
            {
                bind: [
                    id,
                    mapping.guildLinkId,
                    mapping.kind,
                    mapping.discordId,
                    mapping.fluxerId,
                    mapping.createdBySync,
                    JSON.stringify(mapping.appliedFields),
                    now,
                ],
            }
        );
        return {
            id,
            kind: mapping.kind,
            discordId: mapping.discordId,
            fluxerId: mapping.fluxerId,
            state: 'active',
            createdBySync: mapping.createdBySync,
            missingSince: null,
            missingCount: 0,
            appliedFields: mapping.appliedFields,
        };
    }

    async saveApplied(
        rowId: string,
        fields: AppliedFields,
        now: Date
    ): Promise<void> {
        await this.db.query(
            `UPDATE ${TABLES.objectMap} SET "appliedFields" = $2::jsonb, "updatedAt" = $3 WHERE id = $1`,
            { bind: [rowId, JSON.stringify(fields), now] }
        );
    }

    async audit(entry: AuditEntry, now: Date): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.auditLog} ("planId", "guildLinkId", op, kind, "sourceId", "destId", before, after, result, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
            {
                bind: [
                    entry.planId,
                    entry.guildLinkId,
                    entry.op,
                    entry.kind,
                    entry.sourceId,
                    entry.destId,
                    JSON.stringify(entry.before),
                    JSON.stringify(entry.after),
                    entry.result,
                    now,
                ],
            }
        );
    }

    async setPlanStatus(
        planId: string,
        status: PlanStatus,
        abortReason: string | null,
        now: Date
    ): Promise<void> {
        await this.db.query(
            `UPDATE ${TABLES.plans} SET status = $2, "abortReason" = $3, "updatedAt" = $4 WHERE id = $1`,
            { bind: [planId, status, abortReason, now] }
        );
    }

    async setMode(
        guildLinkId: string,
        mode: SyncMode,
        now: Date
    ): Promise<void> {
        await this.loadSettings(guildLinkId);
        await this.db.query(
            `UPDATE ${TABLES.settings} SET mode = $2, "updatedAt" = $3 WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId, mode, now] }
        );
    }

    async setKillSwitch(
        guildLinkId: string,
        on: boolean,
        now: Date
    ): Promise<void> {
        await this.loadSettings(guildLinkId);
        await this.db.query(
            `UPDATE ${TABLES.settings} SET "killSwitch" = $2, "updatedAt" = $3 WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId, on, now] }
        );
    }

    async setEnforceDrift(
        guildLinkId: string,
        on: boolean,
        now: Date
    ): Promise<void> {
        await this.loadSettings(guildLinkId);
        await this.db.query(
            `UPDATE ${TABLES.settings} SET "enforceDrift" = $2, "updatedAt" = $3 WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId, on, now] }
        );
    }

    private async setSetting(
        guildLinkId: string,
        column: 'adminChannelId' | 'approvedPlanId',
        value: string | null,
        now: Date
    ): Promise<void> {
        await this.loadSettings(guildLinkId);
        await this.db.query(
            `UPDATE ${TABLES.settings} SET "${column}" = $2, "updatedAt" = $3 WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId, value, now] }
        );
    }

    setAdminChannel(guildLinkId: string, channelId: string | null, now: Date) {
        return this.setSetting(guildLinkId, 'adminChannelId', channelId, now);
    }

    setApprovedPlan(guildLinkId: string, planId: string | null, now: Date) {
        return this.setSetting(guildLinkId, 'approvedPlanId', planId, now);
    }

    async setRowState(
        rowId: string,
        state: ObjectState,
        now: Date
    ): Promise<void> {
        await this.db.query(
            `UPDATE ${TABLES.objectMap} SET state = $2, "updatedAt" = $3 WHERE id = $1`,
            { bind: [rowId, state, now] }
        );
    }

    async getPlan(planId: string): Promise<Plan | null> {
        const rows = await this.db.query<Row>(
            `SELECT id, "guildLinkId", direction, status, ops, "abortReason" FROM ${TABLES.plans} WHERE id = $1`,
            { bind: [planId], type: QueryTypes.SELECT }
        );
        return rows.length === 0 ? null : parsePlan(rows[0]);
    }

    async lastPlan(guildLinkId: string): Promise<Plan | null> {
        const rows = await this.db.query<Row>(
            `SELECT id, "guildLinkId", direction, status, ops, "abortReason" FROM ${TABLES.plans}
             WHERE "guildLinkId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
            { bind: [guildLinkId], type: QueryTypes.SELECT }
        );
        return rows.length === 0 ? null : parsePlan(rows[0]);
    }

    async loadStatusMessage(
        guildLinkId: string
    ): Promise<StatusMessageRef | null> {
        const rows = await this.db.query<Row>(
            `SELECT "statusChannelId", "statusMessageId" FROM ${TABLES.settings} WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId], type: QueryTypes.SELECT }
        );
        return rows.length === 0 ? null : parseStatusMessage(rows[0]);
    }

    async saveStatusMessage(
        guildLinkId: string,
        ref: StatusMessageRef | null
    ): Promise<void> {
        await this.loadSettings(guildLinkId);
        // Not a setting an admin changed, so "updatedAt" stays as it is.
        await this.db.query(
            `UPDATE ${TABLES.settings} SET "statusChannelId" = $2, "statusMessageId" = $3 WHERE "guildLinkId" = $1`,
            {
                bind: [
                    guildLinkId,
                    ref?.channelId ?? null,
                    ref?.messageId ?? null,
                ],
            }
        );
    }

    async countMapped(guildLinkId: string): Promise<MappedCounts> {
        const rows = await this.db.query<Row>(
            `SELECT kind, count(*) AS count FROM ${TABLES.objectMap}
             WHERE "guildLinkId" = $1 AND state = 'active' GROUP BY kind`,
            { bind: [guildLinkId], type: QueryTypes.SELECT }
        );
        return parseMappedCounts(rows);
    }

    async findThreadPair(side: SnapshotSide, threadId: string) {
        const column = side === 'discord' ? 'discordId' : 'fluxerId';
        const rows = await this.db.query<Row>(
            `SELECT "guildLinkId", "discordId", "fluxerId" FROM ${TABLES.objectMap}
             WHERE kind = 'thread' AND state = 'active' AND "${column}" = $1 LIMIT 1`,
            { bind: [threadId], type: QueryTypes.SELECT }
        );
        const row = rows[0];
        if (
            typeof row?.guildLinkId !== 'string' ||
            typeof row.discordId !== 'string' ||
            typeof row.fluxerId !== 'string'
        ) {
            return null;
        }
        return {
            guildLinkId: row.guildLinkId,
            discordId: row.discordId,
            fluxerId: row.fluxerId,
        };
    }

    async saveThreadMessage(message: ThreadMessage, now: Date): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.threadMessages} ("guildLinkId", "discordThreadId", "fluxerThreadId", "discordMessageId", "fluxerMessageId", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6)`,
            {
                bind: [
                    message.guildLinkId,
                    message.discordThreadId,
                    message.fluxerThreadId,
                    message.discordMessageId,
                    message.fluxerMessageId,
                    now,
                ],
            }
        );
    }

    async findThreadMessage(
        side: SnapshotSide,
        messageId: string
    ): Promise<ThreadMessage | null> {
        const column =
            side === 'discord' ? 'discordMessageId' : 'fluxerMessageId';
        const rows = await this.db.query<Row>(
            `SELECT "guildLinkId", "discordThreadId", "fluxerThreadId", "discordMessageId", "fluxerMessageId"
             FROM ${TABLES.threadMessages} WHERE "${column}" = $1 LIMIT 1`,
            { bind: [messageId], type: QueryTypes.SELECT }
        );
        const row = rows[0];
        if (!row) return null;
        const text = (field: string) => {
            const value = row[field];
            if (typeof value !== 'string') {
                throw new StoreDataError(`thread message ${field} is missing`);
            }
            return value;
        };
        return {
            guildLinkId: text('guildLinkId'),
            discordThreadId: text('discordThreadId'),
            fluxerThreadId: text('fluxerThreadId'),
            discordMessageId: text('discordMessageId'),
            fluxerMessageId: text('fluxerMessageId'),
        };
    }

    async deleteThreadMessage(
        side: SnapshotSide,
        messageId: string
    ): Promise<void> {
        const column =
            side === 'discord' ? 'discordMessageId' : 'fluxerMessageId';
        await this.db.query(
            `DELETE FROM ${TABLES.threadMessages} WHERE "${column}" = $1`,
            { bind: [messageId] }
        );
    }

    /** Snowflakes compare as numbers: left-padded to 20 digits, as text. */
    async historyCovers(
        discordThreadId: string,
        discordMessageId: string
    ): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.historyMessages} WHERE "discordMessageId" = $1
             UNION ALL
             SELECT 1 FROM ${TABLES.historyJobs}
             WHERE kind = 'thread' AND "discordId" = $2 AND status = 'done'
               AND lpad("cutoffId", 20, '0') >= lpad($3, 20, '0')
             LIMIT 1`,
            {
                bind: [discordMessageId, discordThreadId, discordMessageId],
                type: QueryTypes.SELECT,
            }
        );
        return rows.length > 0;
    }
}

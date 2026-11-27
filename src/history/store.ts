import { randomUUID } from 'node:crypto';
import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../addons/db/schema';
import { MAX_MAP_ROWS } from '../guild-sync/store';
import { capMentions } from './mentions';
import type {
    HistoryJob,
    ImportedMessage,
    JobKey,
    JobKind,
    JobPatch,
    JobStatus,
    JobTotals,
} from './types';

/** The database access the history importer needs. */
export interface HistoryStore {
    /** A link's jobs, oldest first, up to MAX_JOBS. */
    listJobs(guildLinkId: string): Promise<HistoryJob[]>;
    /** A link's jobs that are neither done nor failed, up to MAX_JOBS. */
    listOpenJobs(guildLinkId: string): Promise<HistoryJob[]>;
    /** Only the columns planning needs, for every job up to MAX_JOBS. */
    jobKeys(guildLinkId: string): Promise<JobKey[]>;
    jobTotals(guildLinkId: string): Promise<JobTotals>;
    /**
     * True while a job waits for a time rather than for work: a channel
     * copied and waiting for its bridge, or an open job in a backoff.
     */
    hasWaitingJob(guildLinkId: string, now: Date): Promise<boolean>;
    getJob(jobId: string): Promise<HistoryJob | null>;
    /** Creates a job unless one exists for this source. */
    ensureJob(
        guildLinkId: string,
        kind: JobKind,
        discordId: string,
        parentDiscordId: string | null,
        now: Date
    ): Promise<void>;
    updateJob(jobId: string, patch: JobPatch, now: Date): Promise<void>;
    /** Records a message before it is sent, so a crash cannot repeat it. */
    startMessage(message: ImportedMessage, now: Date): Promise<void>;
    finishMessage(
        discordMessageId: string,
        fluxerMessageId: string
    ): Promise<void>;
    dropMessage(discordMessageId: string): Promise<void>;
    /**
     * Replaces the content hash, when a copy is resent or edited with
     * other text.
     */
    setContentHash(discordMessageId: string, hash: string): Promise<void>;
    /**
     * Replaces the Discord users a copy mentions (mentions.ts) and marks
     * them recorded, so the backfill skips the copy. Empty for a copy that
     * no longer renders its source, such as one its author edited.
     */
    recordMentions(
        discordMessageId: string,
        discordUserIds: readonly string[]
    ): Promise<void>;
    /** A message that was being sent when the process stopped. */
    unfinishedMessage(jobId: string): Promise<ImportedMessage | null>;
    importedByFluxerId(
        fluxerMessageId: string
    ): Promise<ImportedMessage | null>;
    importedByDiscordId(
        discordMessageId: string
    ): Promise<ImportedMessage | null>;
    /** True when the thread relay copied this Discord message, either way. */
    relayedInThread(discordMessageId: string): Promise<boolean>;
    /** True when this Fluxer message is one side of a thread relay pair. */
    relayedInThreadByFluxerId(fluxerMessageId: string): Promise<boolean>;
    /**
     * Discord channels guild-sync may bridge: jobs whose history is
     * copied (ready or done), and archive-thread jobs, whose history goes
     * to a thread while live chat flows. A failed inline job never counts;
     * its channel stays unbridged until an admin retries it.
     */
    channelsReadyToBridge(guildLinkId: string): Promise<Set<string>>;
    /** True when this Fluxer thread is an archive thread of history. */
    isArchiveThread(fluxerThreadId: string): Promise<boolean>;
    /**
     * Restarts a link's failed jobs where they stopped, with fresh error
     * counts and skip streak. Returns how many. A job that failed mid
     * streak stopped before its first skip, so the skipped messages are
     * tried again. A job that never started goes back to pending.
     */
    retryFailed(guildLinkId: string, now: Date): Promise<number>;
    isOptedOut(discordUserId: string): Promise<boolean>;
    setOptOut(discordUserId: string, out: boolean, now: Date): Promise<void>;
    /**
     * True while a thread's history is still to be copied: its job is
     * pending or importing. A job whose fluxerId is not filled in yet
     * counts when the active thread pair for this Fluxer thread names its
     * Discord thread. The next history pass maps it and copies its
     * history, so a new reply waits for that instead of landing above it.
     */
    threadImporting(fluxerThreadId: string): Promise<boolean>;
}

export class HistoryDataError extends Error {}

type Row = Record<string, unknown>;

const JOB_STATUSES: readonly JobStatus[] = [
    'pending',
    'importing',
    'ready',
    'done',
    'failed',
];

function str(row: Row, field: string): string {
    const value = row[field];
    if (typeof value !== 'string') {
        throw new HistoryDataError(`${field} is not a string`);
    }
    return value;
}

function optStr(row: Row, field: string): string | null {
    return row[field] === null ? null : str(row, field);
}

function int(row: Row, field: string): number {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new HistoryDataError(`${field} is not an integer`);
    }
    return value;
}

export function parseJob(row: Row): HistoryJob {
    const kind = str(row, 'kind');
    const status = JOB_STATUSES.find((s) => s === row.status);
    if ((kind !== 'channel' && kind !== 'thread') || !status) {
        throw new HistoryDataError('history job has an unknown kind or status');
    }
    const hookId = optStr(row, 'importWebhookId');
    const hookToken = optStr(row, 'importWebhookToken');
    const surveyedAt = row.surveyedAt;
    return {
        id: str(row, 'id'),
        guildLinkId: str(row, 'guildLinkId'),
        kind,
        discordId: str(row, 'discordId'),
        parentDiscordId: optStr(row, 'parentDiscordId'),
        fluxerId: optStr(row, 'fluxerId'),
        status,
        cutoffId: optStr(row, 'cutoffId'),
        checkpointId: str(row, 'checkpointId'),
        catchUps: int(row, 'catchUps'),
        imported: int(row, 'imported'),
        failures: int(row, 'failures'),
        retries: int(row, 'retries'),
        failingId: optStr(row, 'failingId'),
        retryAt: row.retryAt instanceof Date ? row.retryAt : null,
        skipped: int(row, 'skipped'),
        skipStreak: int(row, 'skipStreak'),
        streakFromId: optStr(row, 'streakFromId'),
        messageCount:
            row.messageCount === null ? null : int(row, 'messageCount'),
        attachmentCount:
            row.attachmentCount === null ? null : int(row, 'attachmentCount'),
        surveyedAt: surveyedAt instanceof Date ? surveyedAt : null,
        importWebhook:
            hookId && hookToken ? { id: hookId, token: hookToken } : null,
        archiveThreadId: optStr(row, 'archiveThreadId'),
        lastError: optStr(row, 'lastError'),
    };
}

export function parseImported(row: Row): ImportedMessage {
    if (typeof row.inThread !== 'boolean') {
        throw new HistoryDataError('inThread is not a boolean');
    }
    return {
        discordMessageId: str(row, 'discordMessageId'),
        jobId: str(row, 'jobId'),
        discordAuthorId: str(row, 'discordAuthorId'),
        fluxerMessageId: optStr(row, 'fluxerMessageId'),
        fluxerTargetId: str(row, 'fluxerTargetId'),
        inThread: row.inThread,
        webhookId: str(row, 'webhookId'),
        contentHash: optStr(row, 'contentHash'),
        native: row.native === true,
        nativeReply: row.nativeReply === true,
    };
}

/** Columns a patch may set, with their names in the table. */
const PATCH_COLUMNS: readonly (keyof JobPatch)[] = [
    'fluxerId',
    'status',
    'cutoffId',
    'checkpointId',
    'catchUps',
    'imported',
    'failures',
    'retries',
    'failingId',
    'retryAt',
    'skipped',
    'skipStreak',
    'streakFromId',
    'messageCount',
    'attachmentCount',
    'surveyedAt',
    'archiveThreadId',
    'lastError',
];

/**
 * Upper bound on jobs per guild link: channels plus threads, in line with
 * guild-sync's map rows, where every synced thread has a row too. The
 * importer stops making jobs at this bound (createJobs); listings stop
 * at it rather than fail, so the jobs already made keep running.
 */
export const MAX_JOBS = MAX_MAP_ROWS;

/** A job neither done nor failed. */
const OPEN = `status NOT IN ('done', 'failed')`;

function totalsOf(row: Row | undefined): JobTotals {
    // count() and sum() are bigint, which pg returns as text.
    const num = (field: string) => {
        const value = Number(row?.[field] ?? 0);
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new HistoryDataError(`${field} is not a count`);
        }
        return value;
    };
    return {
        jobs: num('jobs'),
        open: num('open'),
        imported: num('imported'),
        skipped: num('skipped'),
        failed: num('failed'),
    };
}

export class PostgresHistoryStore implements HistoryStore {
    constructor(private readonly db: Sequelize) {
        if (db.getDialect() !== 'postgres') {
            throw new HistoryDataError('history needs Postgres');
        }
    }

    async listJobs(guildLinkId: string): Promise<HistoryJob[]> {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.historyJobs} WHERE "guildLinkId" = $1 ORDER BY "createdAt", id LIMIT $2`,
            { bind: [guildLinkId, MAX_JOBS], type: QueryTypes.SELECT }
        );
        return rows.map(parseJob);
    }

    async listOpenJobs(guildLinkId: string): Promise<HistoryJob[]> {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.historyJobs} WHERE "guildLinkId" = $1 AND ${OPEN} ORDER BY "createdAt", id LIMIT $2`,
            { bind: [guildLinkId, MAX_JOBS], type: QueryTypes.SELECT }
        );
        return rows.map(parseJob);
    }

    async jobKeys(guildLinkId: string): Promise<JobKey[]> {
        const rows = await this.db.query<Row>(
            `SELECT id, kind, "discordId", "fluxerId" FROM ${TABLES.historyJobs} WHERE "guildLinkId" = $1 ORDER BY "createdAt", id LIMIT $2`,
            { bind: [guildLinkId, MAX_JOBS], type: QueryTypes.SELECT }
        );
        return rows.map((row) => {
            const kind = str(row, 'kind');
            if (kind !== 'channel' && kind !== 'thread') {
                throw new HistoryDataError('history job has an unknown kind');
            }
            return {
                id: str(row, 'id'),
                kind,
                discordId: str(row, 'discordId'),
                fluxerId: optStr(row, 'fluxerId'),
            };
        });
    }

    async jobTotals(guildLinkId: string): Promise<JobTotals> {
        const rows = await this.db.query<Row>(
            `SELECT count(*) AS jobs,
                    count(*) FILTER (WHERE ${OPEN}) AS open,
                    coalesce(sum(imported), 0) AS imported,
                    coalesce(sum(skipped), 0) AS skipped,
                    count(*) FILTER (WHERE status = 'failed') AS failed
             FROM ${TABLES.historyJobs} WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId], type: QueryTypes.SELECT }
        );
        return totalsOf(rows[0]);
    }

    async hasWaitingJob(guildLinkId: string, now: Date): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.historyJobs}
             WHERE "guildLinkId" = $1
               AND ((kind = 'channel' AND status = 'ready')
                    OR (${OPEN} AND "retryAt" > $2))
             LIMIT 1`,
            { bind: [guildLinkId, now], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    async getJob(jobId: string): Promise<HistoryJob | null> {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.historyJobs} WHERE id = $1`,
            { bind: [jobId], type: QueryTypes.SELECT }
        );
        return rows[0] ? parseJob(rows[0]) : null;
    }

    async ensureJob(
        guildLinkId: string,
        kind: JobKind,
        discordId: string,
        parentDiscordId: string | null,
        now: Date
    ): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", "parentDiscordId", status, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)
             ON CONFLICT ("guildLinkId", kind, "discordId") DO NOTHING`,
            {
                bind: [
                    randomUUID(),
                    guildLinkId,
                    kind,
                    discordId,
                    parentDiscordId,
                    now,
                ],
            }
        );
    }

    async updateJob(jobId: string, patch: JobPatch, now: Date): Promise<void> {
        const sets: string[] = [];
        const bind: unknown[] = [jobId];
        for (const column of PATCH_COLUMNS) {
            if (!(column in patch)) continue;
            bind.push(patch[column] ?? null);
            sets.push(`"${column}" = $${bind.length}`);
        }
        if ('importWebhook' in patch) {
            bind.push(patch.importWebhook?.id ?? null);
            sets.push(`"importWebhookId" = $${bind.length}`);
            bind.push(patch.importWebhook?.token ?? null);
            sets.push(`"importWebhookToken" = $${bind.length}`);
        }
        bind.push(now);
        sets.push(`"updatedAt" = $${bind.length}`);
        await this.db.query(
            `UPDATE ${TABLES.historyJobs} SET ${sets.join(', ')} WHERE id = $1`,
            { bind }
        );
    }

    async startMessage(message: ImportedMessage, now: Date): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.historyMessages} ("discordMessageId", "jobId", "discordAuthorId", "fluxerMessageId", "fluxerTargetId", "inThread", "webhookId", "createdAt", "contentHash")
             VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8)`,
            {
                bind: [
                    message.discordMessageId,
                    message.jobId,
                    message.discordAuthorId,
                    message.fluxerTargetId,
                    message.inThread,
                    message.webhookId,
                    now,
                    message.contentHash ?? null,
                ],
            }
        );
    }

    async finishMessage(discordMessageId: string, fluxerMessageId: string) {
        await this.db.query(
            `UPDATE ${TABLES.historyMessages} SET "fluxerMessageId" = $2 WHERE "discordMessageId" = $1`,
            { bind: [discordMessageId, fluxerMessageId] }
        );
    }

    async dropMessage(discordMessageId: string): Promise<void> {
        await this.db.query(
            `DELETE FROM ${TABLES.historyMessages} WHERE "discordMessageId" = $1`,
            { bind: [discordMessageId] }
        );
    }

    async setContentHash(discordMessageId: string, hash: string) {
        await this.db.query(
            `UPDATE ${TABLES.historyMessages} SET "contentHash" = $2 WHERE "discordMessageId" = $1`,
            { bind: [discordMessageId, hash] }
        );
    }

    async recordMentions(
        discordMessageId: string,
        discordUserIds: readonly string[]
    ): Promise<void> {
        const ids = capMentions(discordUserIds);
        await this.db.transaction(async (transaction) => {
            await this.db.query(
                `DELETE FROM ${TABLES.historyMentions} WHERE "discordMessageId" = $1`,
                { bind: [discordMessageId], transaction }
            );
            await this.db.query(
                `INSERT INTO ${TABLES.historyMentions} ("discordMessageId", "discordUserId")
                 SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
                { bind: [discordMessageId, ids], transaction }
            );
            await this.db.query(
                `UPDATE ${TABLES.historyMessages} SET "mentionsRecorded" = true WHERE "discordMessageId" = $1`,
                { bind: [discordMessageId], transaction }
            );
        });
    }

    private async oneMessage(where: string, value: string) {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.historyMessages} WHERE ${where} LIMIT 1`,
            { bind: [value], type: QueryTypes.SELECT }
        );
        return rows[0] ? parseImported(rows[0]) : null;
    }

    unfinishedMessage(jobId: string) {
        return this.oneMessage(
            `"jobId" = $1 AND "fluxerMessageId" IS NULL`,
            jobId
        );
    }

    importedByFluxerId(fluxerMessageId: string) {
        return this.oneMessage(`"fluxerMessageId" = $1`, fluxerMessageId);
    }

    importedByDiscordId(discordMessageId: string) {
        return this.oneMessage(`"discordMessageId" = $1`, discordMessageId);
    }

    async relayedInThread(discordMessageId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.threadMessages} WHERE "discordMessageId" = $1 LIMIT 1`,
            { bind: [discordMessageId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    async channelsReadyToBridge(guildLinkId: string): Promise<Set<string>> {
        const rows = await this.db.query<Row>(
            `SELECT "discordId" FROM ${TABLES.historyJobs}
             WHERE "guildLinkId" = $1 AND kind = 'channel'
               AND (status IN ('ready', 'done') OR "archiveThreadId" IS NOT NULL)
             LIMIT $2`,
            { bind: [guildLinkId, MAX_JOBS], type: QueryTypes.SELECT }
        );
        return new Set(rows.map((row) => str(row, 'discordId')));
    }

    async isArchiveThread(fluxerThreadId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.historyJobs} WHERE "archiveThreadId" = $1 LIMIT 1`,
            { bind: [fluxerThreadId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    async retryFailed(guildLinkId: string, now: Date): Promise<number> {
        const rows = await this.db.query<Row>(
            `UPDATE ${TABLES.historyJobs}
             SET status = CASE WHEN "cutoffId" IS NULL THEN 'pending' ELSE 'importing' END,
                 failures = 0, retries = 0, "failingId" = NULL, "skipStreak" = 0, "streakFromId" = NULL,
                 "retryAt" = NULL, "lastError" = NULL, "updatedAt" = $2
             WHERE "guildLinkId" = $1 AND status = 'failed'
             RETURNING id`,
            { bind: [guildLinkId, now], type: QueryTypes.SELECT }
        );
        return rows.length;
    }

    async relayedInThreadByFluxerId(fluxerMessageId: string) {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.threadMessages} WHERE "fluxerMessageId" = $1 LIMIT 1`,
            { bind: [fluxerMessageId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    async isOptedOut(discordUserId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.historyOptOuts} WHERE "discordUserId" = $1`,
            { bind: [discordUserId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    async setOptOut(discordUserId: string, out: boolean, now: Date) {
        await this.db.query(
            out
                ? `INSERT INTO ${TABLES.historyOptOuts} ("discordUserId", "createdAt") VALUES ($1, $2) ON CONFLICT DO NOTHING`
                : `DELETE FROM ${TABLES.historyOptOuts} WHERE "discordUserId" = $1 AND $2::timestamptz IS NOT NULL`,
            { bind: [discordUserId, now] }
        );
    }

    async threadImporting(fluxerThreadId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.historyJobs} j
             WHERE j.kind = 'thread' AND j.status IN ('pending', 'importing')
               AND (j."fluxerId" = $1 OR (j."fluxerId" IS NULL AND j."discordId" IN (
                   SELECT m."discordId" FROM ${TABLES.objectMap} m
                   WHERE m.kind = 'thread' AND m.state = 'active' AND m."fluxerId" = $1)))
             LIMIT 1`,
            { bind: [fluxerThreadId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }
}

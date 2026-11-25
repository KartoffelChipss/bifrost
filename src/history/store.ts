import { randomUUID } from 'node:crypto';
import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../addons/db/schema';
import type {
    HistoryJob,
    ImportedMessage,
    JobKind,
    JobPatch,
    JobStatus,
} from './types';

/** The database access the history importer needs. */
export interface HistoryStore {
    listJobs(guildLinkId: string): Promise<HistoryJob[]>;
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
    /**
     * Discord channels whose history is copied, so guild-sync may bridge
     * them: jobs that are ready or done. A failed job never counts; its
     * channel stays unbridged until an admin retries it.
     */
    channelsReadyToBridge(guildLinkId: string): Promise<Set<string>>;
    /**
     * Restarts a link's failed jobs where they stopped. Returns how many.
     * A job that never started goes back to pending.
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
        retryAt: row.retryAt instanceof Date ? row.retryAt : null,
        skipped: int(row, 'skipped'),
        messageCount:
            row.messageCount === null ? null : int(row, 'messageCount'),
        attachmentCount:
            row.attachmentCount === null ? null : int(row, 'attachmentCount'),
        surveyedAt: surveyedAt instanceof Date ? surveyedAt : null,
        importWebhook:
            hookId && hookToken ? { id: hookId, token: hookToken } : null,
        lastError: optStr(row, 'lastError'),
    };
}

function parseImported(row: Row): ImportedMessage {
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
    'retryAt',
    'skipped',
    'messageCount',
    'attachmentCount',
    'surveyedAt',
    'lastError',
];

/** Upper bound on jobs per guild link: channels plus threads. */
export const MAX_JOBS = 10_000;

export class PostgresHistoryStore implements HistoryStore {
    constructor(private readonly db: Sequelize) {
        if (db.getDialect() !== 'postgres') {
            throw new HistoryDataError('history needs Postgres');
        }
    }

    async listJobs(guildLinkId: string): Promise<HistoryJob[]> {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.historyJobs} WHERE "guildLinkId" = $1 ORDER BY "createdAt", id LIMIT $2`,
            { bind: [guildLinkId, MAX_JOBS + 1], type: QueryTypes.SELECT }
        );
        if (rows.length > MAX_JOBS) {
            throw new HistoryDataError(`over ${MAX_JOBS} history jobs`);
        }
        return rows.map(parseJob);
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
            `INSERT INTO ${TABLES.historyMessages} ("discordMessageId", "jobId", "discordAuthorId", "fluxerMessageId", "fluxerTargetId", "inThread", "webhookId", "createdAt")
             VALUES ($1, $2, $3, NULL, $4, $5, $6, $7)`,
            {
                bind: [
                    message.discordMessageId,
                    message.jobId,
                    message.discordAuthorId,
                    message.fluxerTargetId,
                    message.inThread,
                    message.webhookId,
                    now,
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
             WHERE "guildLinkId" = $1 AND kind = 'channel' AND status IN ('ready', 'done')
             LIMIT $2`,
            { bind: [guildLinkId, MAX_JOBS], type: QueryTypes.SELECT }
        );
        return new Set(rows.map((row) => str(row, 'discordId')));
    }

    async retryFailed(guildLinkId: string, now: Date): Promise<number> {
        const rows = await this.db.query<Row>(
            `UPDATE ${TABLES.historyJobs}
             SET status = CASE WHEN "cutoffId" IS NULL THEN 'pending' ELSE 'importing' END,
                 failures = 0, retries = 0, "retryAt" = NULL, "lastError" = NULL, "updatedAt" = $2
             WHERE "guildLinkId" = $1 AND status = 'failed'
             RETURNING id`,
            { bind: [guildLinkId, now], type: QueryTypes.SELECT }
        );
        return rows.length;
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

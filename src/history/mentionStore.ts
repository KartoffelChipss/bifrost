import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../addons/db/schema';
import { capMentions } from './mentions';
import { HistoryDataError, parseImported } from './store';
import type { ImportedMessage } from './types';

/**
 * The database side of mention fix-ups: the backfill of mentions for
 * copies imported before they were recorded (backfill.ts), and each
 * linked member's fix-up progress (fixup.ts).
 */

/**
 * - pending: copies are still to be checked
 * - previewed: checked in dry-run; apply checks them again from the start
 * - done: every copy that mentions the member renders as it should
 */
export type FixupStatus = 'pending' | 'previewed' | 'done';

const FIXUP_STATUSES: readonly FixupStatus[] = ['pending', 'previewed', 'done'];

/** One linked member's fix-up on one guild link. */
export interface Fixup {
    readonly guildLinkId: string;
    readonly discordUserId: string;
    /** The link this fix-up runs for (identity links.linkedAt). */
    readonly linkedAt: Date;
    readonly status: FixupStatus;
    /** The last Discord message checked, as a snowflake. Starts at '0'. */
    readonly doneTo: string;
    /** Copies edited, or that would be in dry-run. */
    readonly changed: number;
    /** Temporary errors in a row on the copy after doneTo. */
    readonly failures: number;
}

export type FixupPatch = Pick<
    Fixup,
    'status' | 'doneTo' | 'changed' | 'failures'
>;

/** A copy whose mentions the backfill still has to record. */
export interface UnscannedCopy {
    readonly discordMessageId: string;
    readonly discordAuthorId: string;
}

/** The users one source message mentions, as the backfill read them. */
export interface ScannedMessage {
    readonly discordMessageId: string;
    readonly discordUserIds: readonly string[];
}

export interface MentionStore {
    /** Jobs of the link with copies whose mentions are not recorded. */
    scanJobs(guildLinkId: string, limit: number): Promise<string[]>;
    /** A job's sent copies with mentions not recorded, oldest first. */
    unscanned(jobId: string, limit: number): Promise<UnscannedCopy[]>;
    /**
     * Records the mentions of these copies, and moves back any fix-up on
     * the link that already passed a copy now found to mention its member.
     */
    recordScan(
        guildLinkId: string,
        scanned: readonly ScannedMessage[],
        now: Date
    ): Promise<void>;
    /** Marks a job's copies recorded with no mentions: its source is gone. */
    abandonScan(jobId: string): Promise<void>;
    /** True while some sent copy of the link has unrecorded mentions. */
    scanLeft(guildLinkId: string): Promise<boolean>;
    /**
     * Starts a fix-up on each link for each linked member, or for one, that
     * has none for their current link. A fix-up for an older link starts
     * over; one for the current link is kept. Returns rows written.
     */
    ensureFixups(
        guildLinkIds: readonly string[],
        discordUserId: string | null,
        notBefore: Date,
        now: Date
    ): Promise<number>;
    /** Fix-ups due now whose member is still linked as they were. */
    dueFixups(
        guildLinkId: string,
        statuses: readonly FixupStatus[],
        now: Date,
        limit: number
    ): Promise<Fixup[]>;
    /** Sent copies on the link that mention the user, after `afterId`. */
    copiesMentioning(
        guildLinkId: string,
        discordUserId: string,
        afterId: string,
        limit: number
    ): Promise<ImportedMessage[]>;
    /**
     * Saves progress, unless the member unlinked or linked again in the
     * meantime: a newer link's fix-up starts over (ensureFixups).
     */
    saveFixup(fixup: Fixup, patch: FixupPatch, now: Date): Promise<void>;
}

type Row = Record<string, unknown>;

function str(row: Row, field: string): string {
    const value = row[field];
    if (typeof value !== 'string') {
        throw new HistoryDataError(`${field} is not a string`);
    }
    return value;
}

function count(row: Row, field: string): number {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new HistoryDataError(`${field} is not a count`);
    }
    return value;
}

export function parseFixup(row: Row): Fixup {
    const status = FIXUP_STATUSES.find((s) => s === row.status);
    if (!status || !(row.linkedAt instanceof Date)) {
        throw new HistoryDataError('mention fix-up has a bad status or time');
    }
    return {
        guildLinkId: str(row, 'guildLinkId'),
        discordUserId: str(row, 'discordUserId'),
        linkedAt: row.linkedAt,
        status,
        doneTo: str(row, 'doneTo'),
        changed: count(row, 'changed'),
        failures: count(row, 'failures'),
    };
}

/** Parallel arrays of (message, user) pairs, for unnest. */
function pairsOf(scanned: readonly ScannedMessage[]) {
    const messages: string[] = [];
    const users: string[] = [];
    for (const entry of scanned) {
        for (const user of capMentions(entry.discordUserIds)) {
            messages.push(entry.discordMessageId);
            users.push(user);
        }
    }
    return { messages, users };
}

/** A sent copy whose mentions are not recorded yet. */
const UNRECORDED = `m."mentionsRecorded" = false AND m."fluxerMessageId" IS NOT NULL`;

export class PostgresMentionStore implements MentionStore {
    constructor(private readonly db: Sequelize) {
        if (db.getDialect() !== 'postgres') {
            throw new HistoryDataError('history needs Postgres');
        }
    }

    async scanJobs(guildLinkId: string, limit: number): Promise<string[]> {
        const rows = await this.db.query<Row>(
            `SELECT DISTINCT m."jobId" FROM ${TABLES.historyMessages} m
             JOIN ${TABLES.historyJobs} j ON j.id = m."jobId"
             WHERE j."guildLinkId" = $1 AND ${UNRECORDED}
             ORDER BY m."jobId" LIMIT $2`,
            { bind: [guildLinkId, limit], type: QueryTypes.SELECT }
        );
        return rows.map((row) => str(row, 'jobId'));
    }

    async unscanned(jobId: string, limit: number): Promise<UnscannedCopy[]> {
        const rows = await this.db.query<Row>(
            `SELECT m."discordMessageId", m."discordAuthorId" FROM ${TABLES.historyMessages} m
             WHERE m."jobId" = $1 AND ${UNRECORDED}
             ORDER BY m."discordMessageId"::numeric LIMIT $2`,
            { bind: [jobId, limit], type: QueryTypes.SELECT }
        );
        return rows.map((row) => ({
            discordMessageId: str(row, 'discordMessageId'),
            discordAuthorId: str(row, 'discordAuthorId'),
        }));
    }

    async recordScan(
        guildLinkId: string,
        scanned: readonly ScannedMessage[],
        now: Date
    ): Promise<void> {
        if (scanned.length === 0) return;
        const ids = scanned.map((entry) => entry.discordMessageId);
        const { messages, users } = pairsOf(scanned);
        await this.db.transaction(async (transaction) => {
            const run = (sql: string, bind: unknown[]) =>
                this.db.query(sql, { bind, transaction });
            await run(
                `DELETE FROM ${TABLES.historyMentions} WHERE "discordMessageId" = ANY($1::text[])`,
                [ids]
            );
            await run(
                `INSERT INTO ${TABLES.historyMentions} ("discordMessageId", "discordUserId")
                 SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING`,
                [messages, users]
            );
            await run(
                `UPDATE ${TABLES.historyMessages} SET "mentionsRecorded" = true WHERE "discordMessageId" = ANY($1::text[])`,
                [ids]
            );
            await run(REWIND_SQL, [guildLinkId, messages, users, now]);
        });
    }

    async abandonScan(jobId: string): Promise<void> {
        await this.db.query(
            `UPDATE ${TABLES.historyMessages} m SET "mentionsRecorded" = true
             WHERE m."jobId" = $1 AND ${UNRECORDED}`,
            { bind: [jobId] }
        );
    }

    async scanLeft(guildLinkId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.historyMessages} m
             JOIN ${TABLES.historyJobs} j ON j.id = m."jobId"
             WHERE j."guildLinkId" = $1 AND ${UNRECORDED} LIMIT 1`,
            { bind: [guildLinkId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    async ensureFixups(
        guildLinkIds: readonly string[],
        discordUserId: string | null,
        notBefore: Date,
        now: Date
    ): Promise<number> {
        if (guildLinkIds.length === 0) return 0;
        const rows = await this.db.query<Row>(ENSURE_SQL, {
            bind: [[...guildLinkIds], discordUserId, notBefore, now],
            type: QueryTypes.SELECT,
        });
        return rows.length;
    }

    async dueFixups(
        guildLinkId: string,
        statuses: readonly FixupStatus[],
        now: Date,
        limit: number
    ): Promise<Fixup[]> {
        const rows = await this.db.query<Row>(
            `SELECT f.* FROM ${TABLES.mentionFixups} f
             JOIN ${TABLES.identityLinks} l
               ON l."discordUserId" = f."discordUserId" AND l."linkedAt" = f."linkedAt"
             WHERE f."guildLinkId" = $1 AND f.status = ANY($2::text[]) AND f."notBefore" <= $3
             ORDER BY f."notBefore", f."discordUserId" LIMIT $4`,
            {
                bind: [guildLinkId, [...statuses], now, limit],
                type: QueryTypes.SELECT,
            }
        );
        return rows.map(parseFixup);
    }

    async copiesMentioning(
        guildLinkId: string,
        discordUserId: string,
        afterId: string,
        limit: number
    ): Promise<ImportedMessage[]> {
        const rows = await this.db.query<Row>(
            `SELECT m.* FROM ${TABLES.historyMentions} x
             JOIN ${TABLES.historyMessages} m ON m."discordMessageId" = x."discordMessageId"
             JOIN ${TABLES.historyJobs} j ON j.id = m."jobId"
             WHERE x."discordUserId" = $2 AND j."guildLinkId" = $1
               AND m."fluxerMessageId" IS NOT NULL
               AND x."discordMessageId"::numeric > $3::numeric
             ORDER BY x."discordMessageId"::numeric LIMIT $4`,
            {
                bind: [guildLinkId, discordUserId, afterId, limit],
                type: QueryTypes.SELECT,
            }
        );
        return rows.map(parseImported);
    }

    async saveFixup(fixup: Fixup, patch: FixupPatch, now: Date) {
        await this.db.query(
            `UPDATE ${TABLES.mentionFixups}
             SET status = $4, "doneTo" = $5, changed = $6, failures = $7, "updatedAt" = $8
             WHERE "guildLinkId" = $1 AND "discordUserId" = $2 AND "linkedAt" = $3
               AND EXISTS (SELECT 1 FROM ${TABLES.identityLinks} l
                           WHERE l."discordUserId" = $2 AND l."linkedAt" = $3)`,
            {
                bind: [
                    fixup.guildLinkId,
                    fixup.discordUserId,
                    fixup.linkedAt,
                    patch.status,
                    patch.doneTo,
                    patch.changed,
                    patch.failures,
                    now,
                ],
            }
        );
    }
}

/**
 * Moves a fix-up back to just before the oldest newly recorded copy that
 * mentions its member, when it already passed that copy. A finished one
 * runs again and counts afresh.
 */
const REWIND_SQL = `
    UPDATE ${TABLES.mentionFixups} f
    SET status = 'pending',
        "doneTo" = (r.first - 1)::text,
        changed = CASE WHEN f.status = 'pending' THEN f.changed ELSE 0 END,
        failures = 0,
        "updatedAt" = $4
    FROM (
        SELECT t.u AS "discordUserId", min(t.m::numeric) AS first
        FROM unnest($2::text[], $3::text[]) AS t(m, u)
        GROUP BY t.u
    ) r
    WHERE f."guildLinkId" = $1 AND f."discordUserId" = r."discordUserId"
      AND f."doneTo"::numeric >= r.first`;

/** See MentionStore.ensureFixups. */
const ENSURE_SQL = `
    INSERT INTO ${TABLES.mentionFixups}
        ("guildLinkId", "discordUserId", "linkedAt", status, "doneTo", changed, failures, "notBefore", "updatedAt")
    SELECT g.id, l."discordUserId", l."linkedAt", 'pending', '0', 0, 0, $3, $4
    FROM guild_links g CROSS JOIN ${TABLES.identityLinks} l
    WHERE g.id = ANY($1::uuid[]) AND ($2::text IS NULL OR l."discordUserId" = $2)
    ON CONFLICT ("guildLinkId", "discordUserId") DO UPDATE
    SET "linkedAt" = EXCLUDED."linkedAt", status = 'pending', "doneTo" = '0',
        changed = 0, failures = 0, "notBefore" = EXCLUDED."notBefore",
        "updatedAt" = EXCLUDED."updatedAt"
    WHERE ${TABLES.mentionFixups}."linkedAt" IS DISTINCT FROM EXCLUDED."linkedAt"
    RETURNING "discordUserId"`;

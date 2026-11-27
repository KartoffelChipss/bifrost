import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../addons/db/schema';

/** One Fluxer copy of a Discord member's message. */
export interface CopyRef {
    readonly channelId: string;
    readonly messageId: string;
    /** The webhook that posted it, when bifrost knows it. */
    readonly webhookId: string | null;
    readonly webhookToken: string | null;
}

/** An author whose copies may need a new name. */
export interface DueAuthor {
    readonly discordUserId: string;
    readonly appliedName: string | null;
}

/** Copies read per author at most. The largest author today has ~20,000. */
export const MAX_COPIES_PER_AUTHOR = 200_000;
/** An author is retried this many times, then left until marked again. */
export const MAX_NAME_FAILURES = 5;

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
    const value = row[key];
    if (typeof value !== 'string' || value === '') {
        throw new Error(`name sync: ${key} is not a string`);
    }
    return value;
}

function optText(row: Row, key: string): string | null {
    const value = row[key];
    return typeof value === 'string' && value !== '' ? value : null;
}

const COPIES_SQL = `
SELECT h."fluxerTargetId" AS "channelId", h."fluxerMessageId" AS "messageId",
       h."webhookId" AS "webhookId",
       CASE WHEN h."webhookId" = j."importWebhookId" THEN j."importWebhookToken"
            ELSE cl."fluxerWebhookToken" END AS "webhookToken"
FROM ${TABLES.historyMessages} h
JOIN ${TABLES.historyJobs} j ON j.id = h."jobId"
LEFT JOIN channel_links cl
  ON cl."fluxerWebhookId" = h."webhookId" AND cl."guildLinkId" = j."guildLinkId"
WHERE j."guildLinkId" = $1 AND h."discordAuthorId" = $2
  AND h."fluxerMessageId" IS NOT NULL
UNION ALL
SELECT cl."fluxerChannelId", ml."fluxerMessageId", cl."fluxerWebhookId",
       cl."fluxerWebhookToken"
FROM message_links ml
JOIN channel_links cl ON cl.id = ml."channelLinkId"
JOIN ${TABLES.archiveMessages} a ON a."messageId" = ml."discordMessageId"
WHERE ml."guildLinkId" = $1 AND a."authorId" = $2
UNION ALL
SELECT t."fluxerThreadId", t."fluxerMessageId", NULL, NULL
FROM ${TABLES.threadMessages} t
JOIN ${TABLES.archiveMessages} a ON a."messageId" = t."discordMessageId"
WHERE t."guildLinkId" = $1 AND a."authorId" = $2
LIMIT $3`;

const SEED_SQL = `
INSERT INTO ${TABLES.nameSync} ("guildId", "discordUserId", dirty)
SELECT DISTINCT $1::text, author, true FROM (
  SELECT h."discordAuthorId" AS author
  FROM ${TABLES.historyMessages} h
  JOIN ${TABLES.historyJobs} j ON j.id = h."jobId"
  WHERE j."guildLinkId" = $2 AND h."fluxerMessageId" IS NOT NULL
  UNION
  SELECT a."authorId" FROM message_links ml
  JOIN ${TABLES.archiveMessages} a ON a."messageId" = ml."discordMessageId"
  WHERE ml."guildLinkId" = $2
  UNION
  SELECT a."authorId" FROM ${TABLES.threadMessages} t
  JOIN ${TABLES.archiveMessages} a ON a."messageId" = t."discordMessageId"
  WHERE t."guildLinkId" = $2
) authors
ON CONFLICT ("guildId", "discordUserId") DO NOTHING`;

/** Name sync's own table, plus the copy lookups it needs. */
export class PostgresNameStore {
    constructor(private readonly db: Sequelize) {}

    /** Adds every author with copies on this link that has no row yet. */
    async seed(guildId: string, guildLinkId: string): Promise<void> {
        await this.db.query(SEED_SQL, {
            bind: [guildId, guildLinkId],
            type: QueryTypes.INSERT,
        });
    }

    /** Marks an author for another pass, in one server or in all. */
    async markDirty(discordUserId: string, guildId?: string): Promise<void> {
        const scoped = guildId ? ` AND "guildId" = $2` : '';
        await this.db.query(
            `UPDATE ${TABLES.nameSync} SET dirty = true, failures = 0
             WHERE "discordUserId" = $1${scoped}`,
            {
                bind: guildId ? [discordUserId, guildId] : [discordUserId],
                type: QueryTypes.UPDATE,
            }
        );
    }

    async due(guildId: string, limit: number): Promise<DueAuthor[]> {
        const rows = await this.db.query<Row>(
            `SELECT "discordUserId", "appliedName" FROM ${TABLES.nameSync}
             WHERE "guildId" = $1 AND dirty AND failures < $2
             ORDER BY "appliedAt" NULLS FIRST LIMIT $3`,
            {
                bind: [guildId, MAX_NAME_FAILURES, limit],
                type: QueryTypes.SELECT,
            }
        );
        return rows.map((row) => ({
            discordUserId: text(row, 'discordUserId'),
            appliedName: optText(row, 'appliedName'),
        }));
    }

    async applied(
        guildId: string,
        discordUserId: string,
        name: string | null,
        at: Date
    ): Promise<void> {
        await this.db.query(
            `UPDATE ${TABLES.nameSync}
             SET "appliedName" = $3, dirty = false, failures = 0, "appliedAt" = $4
             WHERE "guildId" = $1 AND "discordUserId" = $2`,
            {
                bind: [guildId, discordUserId, name, at],
                type: QueryTypes.UPDATE,
            }
        );
    }

    async failed(guildId: string, discordUserId: string): Promise<void> {
        await this.db.query(
            `UPDATE ${TABLES.nameSync} SET failures = failures + 1
             WHERE "guildId" = $1 AND "discordUserId" = $2`,
            { bind: [guildId, discordUserId], type: QueryTypes.UPDATE }
        );
    }

    async isOptedOut(discordUserId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${TABLES.historyOptOuts} WHERE "discordUserId" = $1 LIMIT 1`,
            { bind: [discordUserId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    /** Every Fluxer copy bifrost made of this author's messages on a link. */
    async copies(
        guildLinkId: string,
        discordUserId: string
    ): Promise<CopyRef[]> {
        const rows = await this.db.query<Row>(COPIES_SQL, {
            bind: [guildLinkId, discordUserId, MAX_COPIES_PER_AUTHOR],
            type: QueryTypes.SELECT,
        });
        return rows.map((row) => ({
            channelId: text(row, 'channelId'),
            messageId: text(row, 'messageId'),
            webhookId: optText(row, 'webhookId'),
            webhookToken: optText(row, 'webhookToken'),
        }));
    }
}

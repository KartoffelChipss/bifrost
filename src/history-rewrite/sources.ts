import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../addons/db/schema';
import type { CopyRow, ReplyTarget } from './plan';

/** One copy to rewrite, with its Discord original from the archive. */
export interface PendingCopy extends CopyRow {
    readonly raw: unknown;
}

/** A copy the job finished, for bifrost's own table. */
export interface DoneCopy {
    readonly discordMessageId: string;
    readonly oldFluxerMessageId: string;
    readonly nativeReply: boolean;
    readonly contentHash: string;
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
    const value = row[key];
    if (typeof value !== 'string' || value === '') {
        throw new Error(`rewrite: ${key} is not a string`);
    }
    return value;
}

/** Bifrost's side of the rewrite: what to move, and recording it. */
export class BifrostSource {
    constructor(private readonly db: Sequelize) {}

    /** Fluxer channels that still hold copies to rewrite. */
    async channels(limit: number): Promise<string[]> {
        const rows = await this.db.query<Row>(
            `SELECT DISTINCT "fluxerTargetId" FROM ${TABLES.historyMessages}
             WHERE NOT native AND "fluxerMessageId" IS NOT NULL
             ORDER BY "fluxerTargetId" LIMIT $1`,
            { bind: [limit], type: QueryTypes.SELECT }
        );
        return rows.map((r) => text(r, 'fluxerTargetId'));
    }

    /** The next copies of a channel, oldest first, after `afterId`. */
    async batch(
        channelId: string,
        afterId: string,
        limit: number
    ): Promise<PendingCopy[]> {
        const rows = await this.db.query<Row>(
            `SELECT h."discordMessageId", h."fluxerMessageId", h."fluxerTargetId",
                    h."webhookId", a.raw
             FROM ${TABLES.historyMessages} h
             LEFT JOIN ${TABLES.archiveMessages} a ON a."messageId" = h."discordMessageId"
             WHERE NOT h.native AND h."fluxerMessageId" IS NOT NULL
               AND h."fluxerTargetId" = $1
               AND h."discordMessageId"::numeric > $2::numeric
             ORDER BY h."discordMessageId"::numeric LIMIT $3`,
            { bind: [channelId, afterId, limit], type: QueryTypes.SELECT }
        );
        return rows.map((r) => ({
            discordMessageId: text(r, 'discordMessageId'),
            fluxerMessageId: text(r, 'fluxerMessageId'),
            fluxerTargetId: text(r, 'fluxerTargetId'),
            webhookId: text(r, 'webhookId'),
            raw: r.raw ?? null,
        }));
    }

    /**
     * Where each copied Discord message is after the rewrite: a history
     * copy in a moved channel takes its Discord ID; one in a thread keeps
     * its ID; a live copy keeps its ID.
     */
    async replyTargets(
        threads: ReadonlySet<string>
    ): Promise<Map<string, ReplyTarget>> {
        const history = await this.db.query<Row>(
            `SELECT "discordMessageId", "fluxerMessageId", "fluxerTargetId"
             FROM ${TABLES.historyMessages} WHERE "fluxerMessageId" IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );
        const live = await this.db.query<Row>(
            `SELECT ml."discordMessageId", ml."fluxerMessageId", cl."fluxerChannelId"
             FROM message_links ml JOIN channel_links cl ON cl.id = ml."channelLinkId"`,
            { type: QueryTypes.SELECT }
        );
        const targets = new Map<string, ReplyTarget>();
        for (const r of live) {
            targets.set(text(r, 'discordMessageId'), {
                fluxerChannelId: text(r, 'fluxerChannelId'),
                fluxerMessageId: text(r, 'fluxerMessageId'),
            });
        }
        for (const r of history) {
            const channel = text(r, 'fluxerTargetId');
            const discordId = text(r, 'discordMessageId');
            targets.set(discordId, {
                fluxerChannelId: channel,
                fluxerMessageId: threads.has(channel)
                    ? text(r, 'fluxerMessageId')
                    : discordId,
            });
        }
        return targets;
    }

    /** Discord emoji ID → Fluxer emoji ID, for emojis guild-sync copied. */
    async emojis(): Promise<Map<string, string>> {
        const rows = await this.db.query<Row>(
            `SELECT "discordId", "fluxerId" FROM ${TABLES.objectMap}
             WHERE kind = 'emoji' AND state = 'active'
               AND "discordId" IS NOT NULL AND "fluxerId" IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );
        return new Map(
            rows.map((r) => [text(r, 'discordId'), text(r, 'fluxerId')])
        );
    }

    /** Records finished copies: their new ID, the old one, and their style. */
    async recordDone(done: readonly DoneCopy[]): Promise<void> {
        if (done.length === 0) return;
        await this.db.query(
            `UPDATE ${TABLES.historyMessages} h
             SET "formerFluxerMessageId" = h."fluxerMessageId",
                 "fluxerMessageId" = h."discordMessageId",
                 native = true,
                 "nativeReply" = d."nativeReply",
                 "contentHash" = d."contentHash"
             FROM jsonb_to_recordset($1::jsonb)
               AS d("discordMessageId" text, "oldFluxerMessageId" text,
                    "nativeReply" boolean, "contentHash" text)
             WHERE h."discordMessageId" = d."discordMessageId"
               AND h."fluxerMessageId" = d."oldFluxerMessageId"`,
            { bind: [JSON.stringify(done)], type: QueryTypes.UPDATE }
        );
    }

    /** Other sessions on bifrost's database; the bot must be stopped. */
    async otherSessions(): Promise<string[]> {
        return otherSessions(this.db);
    }
}

/** Client sessions on the same database other than this one. */
export async function otherSessions(db: Sequelize): Promise<string[]> {
    const rows = await db.query<Row>(
        `SELECT COALESCE(NULLIF(application_name, ''), 'unnamed') AS app
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND backend_type = 'client backend'`,
        { type: QueryTypes.SELECT }
    );
    return rows.map((r) => String(r.app));
}

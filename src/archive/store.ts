import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../addons/db/schema';
import type {
    ArchiveTarget,
    ChannelProgress,
    ChannelStatus,
    FileKind,
    FileRef,
    MemberSnapshot,
    RawMessage,
} from './types';

/** Upper bounds on rows one query returns. */
const MAX_CHANNELS = 2_000;
const MAX_ROWS = 500;
/** Failures before a channel walk stops for good, until restarted. */
export const MAX_CHANNEL_FAILURES = 5;
/** Failures before a file is given up on. */
export const MAX_FILE_FAILURES = 5;
/** A file that failed, or was held for space, is tried again after this. */
export const FILE_RETRY_MS = 10 * 60_000;

type Row = Record<string, unknown>;

const C = TABLES.archiveChannels;
const M = TABLES.archiveMessages;
const MB = TABLES.archiveMembers;
const F = TABLES.archiveFiles;

const STATUSES: readonly ChannelStatus[] = [
    'walking',
    'current',
    'failed',
    'forbidden',
];

function parseProgress(row: Row): ChannelProgress {
    const status = STATUSES.find((s) => s === row.status);
    if (!status) throw new Error(`archive channel has status ${row.status}`);
    return {
        channelId: String(row.channelId),
        guildId: String(row.guildId),
        kind: row.kind === 'thread' ? 'thread' : 'channel',
        parentId: row.parentId == null ? null : String(row.parentId),
        afterId: String(row.afterId),
        status,
        messages: Number(row.messages),
        failures: Number(row.failures),
        walkedAt: row.walkedAt instanceof Date ? row.walkedAt : null,
    };
}

/** A message row: the API JSON, or nothing for an opted-out author. */
export interface MessageRow {
    readonly message: RawMessage;
    readonly redacted: boolean;
}

/** A file to download again, with where its message lives. */
export interface FileRetry {
    readonly kind: FileKind;
    readonly sourceId: string;
    readonly messageId: string;
    readonly channelId: string;
}

export interface ArchiveTotals {
    readonly channels: number;
    readonly current: number;
    readonly messages: number;
    readonly stored: number;
    readonly pending: number;
    readonly bytes: number;
}

/** The archive's tables (migration 00015). */
export class PostgresArchiveStore {
    constructor(private readonly db: Sequelize) {}

    /** Adds channels the archive has not seen yet, to walk from the start. */
    async ensureChannels(
        targets: readonly ArchiveTarget[],
        now: Date
    ): Promise<void> {
        for (const t of targets.slice(0, MAX_CHANNELS)) {
            await this.db.query(
                `INSERT INTO ${C} ("channelId", "guildId", kind, "parentId", "afterId", status, "updatedAt")
                 VALUES ($1, $2, $3, $4, '0', 'walking', $5) ON CONFLICT ("channelId") DO NOTHING`,
                { bind: [t.channelId, t.guildId, t.kind, t.parentId, now] }
            );
        }
    }

    async channels(guildId: string): Promise<ChannelProgress[]> {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${C} WHERE "guildId" = $1 ORDER BY "channelId" LIMIT $2`,
            { bind: [guildId, MAX_CHANNELS], type: QueryTypes.SELECT }
        );
        return rows.map(parseProgress);
    }

    /** Records a page: the walk goes on after `afterId`. */
    async advance(
        channelId: string,
        afterId: string,
        added: number,
        now: Date
    ): Promise<void> {
        await this.db.query(
            `UPDATE ${C} SET "afterId" = $2, messages = messages + $3, failures = 0, "lastError" = NULL,
                    status = CASE WHEN status = 'current' THEN 'current' ELSE 'walking' END, "updatedAt" = $4
             WHERE "channelId" = $1`,
            { bind: [channelId, afterId, added, now] }
        );
    }

    /** The walk reached the newest message. */
    async caughtUp(channelId: string, now: Date): Promise<void> {
        await this.db.query(
            `UPDATE ${C} SET status = 'current', failures = 0, "lastError" = NULL, "walkedAt" = $2, "updatedAt" = $2
             WHERE "channelId" = $1`,
            { bind: [channelId, now] }
        );
    }

    async setStatus(
        channelId: string,
        status: 'forbidden' | 'walking',
        now: Date
    ): Promise<void> {
        await this.db.query(
            `UPDATE ${C} SET status = $2, failures = 0, "updatedAt" = $3 WHERE "channelId" = $1`,
            { bind: [channelId, status, now] }
        );
    }

    /** Counts a failed walk; at MAX_CHANNEL_FAILURES it stops. */
    async failed(channelId: string, error: string, now: Date): Promise<void> {
        await this.db.query(
            `UPDATE ${C} SET failures = failures + 1, "lastError" = $2, "updatedAt" = $3,
                    status = CASE WHEN failures + 1 >= $4 THEN 'failed' ELSE status END
             WHERE "channelId" = $1`,
            {
                bind: [
                    channelId,
                    error.slice(0, 500),
                    now,
                    MAX_CHANNEL_FAILURES,
                ],
            }
        );
    }

    /** Stores messages, replacing an earlier copy of the same message. */
    async saveMessages(
        guildId: string,
        rows: readonly MessageRow[],
        now: Date
    ): Promise<void> {
        for (const { message: m, redacted } of rows.slice(0, MAX_ROWS)) {
            await this.db.query(
                `INSERT INTO ${M} ("messageId", "channelId", "guildId", "authorId", "createdAt", "editedAt", raw, redacted, "fetchedAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT ("messageId") DO UPDATE SET "editedAt" = EXCLUDED."editedAt", raw = EXCLUDED.raw,
                    redacted = EXCLUDED.redacted, "fetchedAt" = EXCLUDED."fetchedAt"`,
                {
                    bind: [
                        m.id,
                        m.channel_id,
                        guildId,
                        m.author.id,
                        new Date(m.timestamp),
                        m.edited_timestamp
                            ? new Date(m.edited_timestamp)
                            : null,
                        redacted ? null : JSON.stringify(m.json),
                        redacted,
                        now,
                    ],
                }
            );
        }
    }

    async hasMessage(messageId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${M} WHERE "messageId" = $1 AND NOT redacted`,
            { bind: [messageId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    /** Which of these users opted out of history (identity's opt-out). */
    async optedOut(userIds: readonly string[]): Promise<Set<string>> {
        if (userIds.length === 0) return new Set();
        const rows = await this.db.query<Row>(
            `SELECT "discordUserId" FROM ${TABLES.historyOptOuts} WHERE "discordUserId" = ANY($1)`,
            { bind: [userIds.slice(0, MAX_ROWS)], type: QueryTypes.SELECT }
        );
        return new Set(rows.map((r) => String(r.discordUserId)));
    }

    /** Records files to fetch; files already known keep their state. */
    async saveFiles(refs: readonly FileRef[], now: Date): Promise<void> {
        for (const f of refs.slice(0, MAX_ROWS)) {
            await this.db.query(
                `INSERT INTO ${F} (kind, "sourceId", "messageId", filename, size, "contentType", status, "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) ON CONFLICT (kind, "sourceId") DO NOTHING`,
                {
                    bind: [
                        f.kind,
                        f.sourceId,
                        f.messageId,
                        f.filename,
                        f.size,
                        f.contentType,
                        now,
                    ],
                }
            );
        }
    }

    /** True when the file still has to be downloaded. */
    async fileWanted(kind: FileKind, sourceId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${F} WHERE kind = $1 AND "sourceId" = $2 AND status IN ('pending', 'failed') AND failures < $3`,
            {
                bind: [kind, sourceId, MAX_FILE_FAILURES],
                type: QueryTypes.SELECT,
            }
        );
        return rows.length > 0;
    }

    async fileStored(
        kind: FileKind,
        sourceId: string,
        stored: { sha256: string; size: number },
        now: Date
    ): Promise<void> {
        await this.db.query(
            `UPDATE ${F} SET status = 'stored', sha256 = $3, size = $4, "updatedAt" = $5 WHERE kind = $1 AND "sourceId" = $2`,
            { bind: [kind, sourceId, stored.sha256, stored.size, now] }
        );
    }

    async fileGone(kind: FileKind, sourceId: string, now: Date) {
        await this.db.query(
            `UPDATE ${F} SET status = 'gone', "updatedAt" = $3 WHERE kind = $1 AND "sourceId" = $2`,
            { bind: [kind, sourceId, now] }
        );
    }

    /** Held for space: tried again FILE_RETRY_MS from now. */
    async fileHeld(kind: FileKind, sourceId: string, now: Date) {
        await this.db.query(
            `UPDATE ${F} SET "updatedAt" = $3 WHERE kind = $1 AND "sourceId" = $2`,
            { bind: [kind, sourceId, now] }
        );
    }

    async fileFailed(kind: FileKind, sourceId: string, now: Date) {
        await this.db.query(
            `UPDATE ${F} SET status = 'failed', failures = failures + 1, "updatedAt" = $3 WHERE kind = $1 AND "sourceId" = $2`,
            { bind: [kind, sourceId, now] }
        );
    }

    /**
     * Files still to fetch whose last attempt is over FILE_RETRY_MS old,
     * oldest attempt first, with their channel.
     */
    async filesToRetry(limit: number, now = new Date()): Promise<FileRetry[]> {
        const before = new Date(now.getTime() - FILE_RETRY_MS);
        const rows = await this.db.query<Row>(
            `SELECT f.kind, f."sourceId", f."messageId", m."channelId" FROM ${F} f
             JOIN ${M} m ON m."messageId" = f."messageId" AND NOT m.redacted
             WHERE f.status IN ('pending', 'failed') AND f.failures < $1 AND f."updatedAt" < $3
             ORDER BY f."updatedAt" LIMIT $2`,
            {
                bind: [MAX_FILE_FAILURES, Math.min(limit, MAX_ROWS), before],
                type: QueryTypes.SELECT,
            }
        );
        return rows.map((r) => ({
            kind: r.kind === 'sticker' ? 'sticker' : 'attachment',
            sourceId: String(r.sourceId),
            messageId: String(r.messageId),
            channelId: String(r.channelId),
        }));
    }

    /** When each user's snapshot was last taken in this guild. */
    async membersSeen(
        guildId: string,
        userIds: readonly string[]
    ): Promise<Map<string, Date>> {
        if (userIds.length === 0) return new Map();
        const rows = await this.db.query<Row>(
            `SELECT "userId", "seenAt" FROM ${MB} WHERE "guildId" = $1 AND "userId" = ANY($2)`,
            {
                bind: [guildId, userIds.slice(0, MAX_ROWS)],
                type: QueryTypes.SELECT,
            }
        );
        return new Map(
            rows.map((r) => [String(r.userId), new Date(String(r.seenAt))])
        );
    }

    async saveMember(member: MemberSnapshot, now: Date): Promise<void> {
        const m = member;
        await this.db.query(
            `INSERT INTO ${MB} ("guildId", "userId", username, "globalName", nick, avatar, "serverAvatar", "inGuild", "seenAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT ("guildId", "userId") DO UPDATE SET username = EXCLUDED.username, "globalName" = EXCLUDED."globalName",
                nick = EXCLUDED.nick, avatar = EXCLUDED.avatar, "serverAvatar" = EXCLUDED."serverAvatar",
                "inGuild" = EXCLUDED."inGuild", "seenAt" = EXCLUDED."seenAt"`,
            {
                bind: [
                    m.guildId,
                    m.userId,
                    m.username,
                    m.globalName,
                    m.nick,
                    m.avatar,
                    m.serverAvatar,
                    m.inGuild,
                    now,
                ],
            }
        );
    }

    /**
     * Empties the messages of authors who opted out, and drops their file
     * rows. Returns the hashes no other row refers to, to delete from disk.
     */
    async redactOptedOut(limit: number): Promise<string[]> {
        const ids = await this.db.query<Row>(
            `UPDATE ${M} SET raw = NULL, redacted = true WHERE "messageId" IN (
                SELECT m."messageId" FROM ${M} m JOIN ${TABLES.historyOptOuts} o ON o."discordUserId" = m."authorId"
                WHERE NOT m.redacted LIMIT $1) RETURNING "messageId"`,
            { bind: [Math.min(limit, MAX_ROWS)], type: QueryTypes.SELECT }
        );
        return this.dropFiles(ids.map((r) => String(r.messageId)));
    }

    /**
     * Deletes a message Discord deleted, and its file rows. Returns the
     * hashes no other row refers to, to delete from disk.
     */
    async deleteMessage(messageId: string): Promise<string[]> {
        const hashes = await this.dropFiles([messageId]);
        await this.db.query(`DELETE FROM ${M} WHERE "messageId" = $1`, {
            bind: [messageId],
        });
        return hashes;
    }

    /**
     * Drops the attachment rows of these messages. Sticker images are the
     * server's, shared by many messages, so they stay.
     */
    private async dropFiles(messageIds: readonly string[]): Promise<string[]> {
        if (messageIds.length === 0) return [];
        const dropped = await this.db.query<Row>(
            `DELETE FROM ${F} WHERE "messageId" = ANY($1) AND kind = 'attachment' RETURNING sha256`,
            { bind: [messageIds], type: QueryTypes.SELECT }
        );
        const hashes = [
            ...new Set(
                dropped
                    .filter((r) => r.sha256 != null)
                    .map((r) => String(r.sha256))
            ),
        ];
        if (hashes.length === 0) return [];
        const kept = await this.db.query<Row>(
            `SELECT DISTINCT sha256 FROM ${F} WHERE sha256 = ANY($1)`,
            { bind: [hashes], type: QueryTypes.SELECT }
        );
        const still = new Set(kept.map((r) => String(r.sha256)));
        return hashes.filter((h) => !still.has(h));
    }

    async totals(): Promise<ArchiveTotals> {
        const [row] = await this.db.query<Row>(
            `SELECT (SELECT count(*) FROM ${C}) AS channels,
                    (SELECT count(*) FROM ${C} WHERE status = 'current') AS current,
                    (SELECT count(*) FROM ${M}) AS messages,
                    (SELECT count(*) FROM ${F} WHERE status = 'stored') AS stored,
                    (SELECT count(*) FROM ${F} WHERE status IN ('pending', 'failed')) AS pending,
                    (SELECT coalesce(sum(size), 0) FROM ${F} WHERE status = 'stored') AS bytes`,
            { type: QueryTypes.SELECT }
        );
        return {
            channels: Number(row?.channels ?? 0),
            current: Number(row?.current ?? 0),
            messages: Number(row?.messages ?? 0),
            stored: Number(row?.stored ?? 0),
            pending: Number(row?.pending ?? 0),
            bytes: Number(row?.bytes ?? 0),
        };
    }
}

import { QueryTypes, type Sequelize } from 'sequelize';
import { SNAPSHOT_SIDES, TABLES, type SnapshotSide } from '../addons/db/schema';

/**
 * Thread replies held until their thread exists on the other side, or
 * until the thread's history is copied. Only the message's address is
 * kept; the relay fetches the message again when it sends it, so the copy
 * carries the latest text and a deleted message is never posted.
 */

/** Messages held for threads that are not created on the other side yet. */
export const MAX_PARKED_MESSAGES = 2_000;

export interface ParkedMessage {
    readonly from: SnapshotSide;
    readonly messageId: string;
    /** The thread the message is in. */
    readonly threadId: string;
    /** The thread's parent channel. */
    readonly parentId: string;
    readonly webhookId: string | null;
    /** When it was parked, in epoch milliseconds. */
    readonly parkedAt: number;
}

/** One thread with held messages, on the side they were posted. */
export interface ParkedThread {
    readonly from: SnapshotSide;
    readonly threadId: string;
}

export interface ParkedMessageStore {
    /** Holds a message. The oldest are dropped above the limit. */
    park(message: ParkedMessage): Promise<void>;
    /** True when the thread has held messages. */
    waiting(from: SnapshotSide, threadId: string): Promise<boolean>;
    /** A thread's held messages, oldest first. */
    list(
        from: SnapshotSide,
        threadId: string,
        limit: number
    ): Promise<ParkedMessage[]>;
    /** Threads with held messages, the longest waiting first. */
    threads(limit: number): Promise<ParkedThread[]>;
    /** Drops a held message. True when it was held. */
    remove(from: SnapshotSide, messageId: string): Promise<boolean>;
    /** Counts a failed send. Returns the failures so far. */
    failed(from: SnapshotSide, messageId: string): Promise<number>;
    /** Drops messages parked before `before` (epoch milliseconds). */
    expire(before: number): Promise<void>;
}

interface MemoryEntry extends ParkedMessage {
    failures: number;
}

/** The store used when no database is wired: lost on restart. */
export class MemoryParkedMessages implements ParkedMessageStore {
    private entries: MemoryEntry[] = [];

    constructor(private readonly max = MAX_PARKED_MESSAGES) {}

    get size(): number {
        return this.entries.length;
    }

    async park(message: ParkedMessage): Promise<void> {
        await this.remove(message.from, message.messageId);
        this.entries.push({ ...message, failures: 0 });
        if (this.entries.length > this.max) this.entries.shift();
    }

    async waiting(from: SnapshotSide, threadId: string): Promise<boolean> {
        return this.entries.some(
            (e) => e.from === from && e.threadId === threadId
        );
    }

    async list(from: SnapshotSide, threadId: string, limit: number) {
        return this.entries
            .filter((e) => e.from === from && e.threadId === threadId)
            .slice(0, limit)
            .map((e) => ({
                from: e.from,
                messageId: e.messageId,
                threadId: e.threadId,
                parentId: e.parentId,
                webhookId: e.webhookId,
                parkedAt: e.parkedAt,
            }));
    }

    async threads(limit: number): Promise<ParkedThread[]> {
        const seen = new Map<string, ParkedThread>();
        for (const e of this.entries) {
            if (seen.size >= limit) break;
            const key = `${e.from}:${e.threadId}`;
            if (!seen.has(key)) {
                seen.set(key, { from: e.from, threadId: e.threadId });
            }
        }
        return [...seen.values()];
    }

    async remove(from: SnapshotSide, messageId: string): Promise<boolean> {
        const before = this.entries.length;
        this.entries = this.entries.filter(
            (e) => e.from !== from || e.messageId !== messageId
        );
        return this.entries.length < before;
    }

    async failed(from: SnapshotSide, messageId: string): Promise<number> {
        const entry = this.entries.find(
            (e) => e.from === from && e.messageId === messageId
        );
        if (!entry) return 0;
        entry.failures += 1;
        return entry.failures;
    }

    async expire(before: number): Promise<void> {
        this.entries = this.entries.filter((e) => e.parkedAt >= before);
    }
}

type Row = Record<string, unknown>;

export class ParkedDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ParkedDataError';
    }
}

function side(value: unknown): SnapshotSide {
    const found = SNAPSHOT_SIDES.find((s) => s === value);
    if (!found) throw new ParkedDataError(`bad parked side ${String(value)}`);
    return found;
}

function text(row: Row, field: string): string {
    const value = row[field];
    if (typeof value !== 'string' || value === '') {
        throw new ParkedDataError(`parked message ${field} is missing`);
    }
    return value;
}

function toParked(row: Row): ParkedMessage {
    const at = row.createdAt;
    const parkedAt = at instanceof Date ? at.getTime() : Date.parse(String(at));
    if (!Number.isFinite(parkedAt)) {
        throw new ParkedDataError('parked message createdAt is invalid');
    }
    return {
        from: side(row.side),
        messageId: text(row, 'messageId'),
        threadId: text(row, 'threadId'),
        parentId: text(row, 'parentId'),
        webhookId: typeof row.webhookId === 'string' ? row.webhookId : null,
        parkedAt,
    };
}

/** `addon_parked_messages`: held messages that survive a restart. */
export class PostgresParkedMessages implements ParkedMessageStore {
    private readonly table = TABLES.parkedMessages;

    constructor(
        private readonly db: Sequelize,
        private readonly max = MAX_PARKED_MESSAGES
    ) {
        if (db.getDialect() !== 'postgres') {
            throw new ParkedDataError('parked messages need Postgres');
        }
    }

    async park(m: ParkedMessage): Promise<void> {
        await this.db.query(
            `INSERT INTO ${this.table} (side, "messageId", "threadId", "parentId", "webhookId", failures, "createdAt")
             VALUES ($1, $2, $3, $4, $5, 0, $6)
             ON CONFLICT (side, "messageId") DO NOTHING`,
            {
                bind: [
                    m.from,
                    m.messageId,
                    m.threadId,
                    m.parentId,
                    m.webhookId,
                    new Date(m.parkedAt),
                ],
            }
        );
        await this.db.query(
            `DELETE FROM ${this.table} WHERE id IN (
                SELECT id FROM ${this.table} ORDER BY id DESC OFFSET $1)`,
            { bind: [this.max] }
        );
    }

    async waiting(from: SnapshotSide, threadId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 FROM ${this.table} WHERE side = $1 AND "threadId" = $2 LIMIT 1`,
            { bind: [from, threadId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    async list(from: SnapshotSide, threadId: string, limit: number) {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${this.table} WHERE side = $1 AND "threadId" = $2
             ORDER BY id LIMIT $3`,
            { bind: [from, threadId, limit], type: QueryTypes.SELECT }
        );
        return rows.map(toParked);
    }

    async threads(limit: number): Promise<ParkedThread[]> {
        const rows = await this.db.query<Row>(
            `SELECT side, "threadId" FROM ${this.table}
             GROUP BY side, "threadId" ORDER BY MIN(id) LIMIT $1`,
            { bind: [limit], type: QueryTypes.SELECT }
        );
        return rows.map((row) => ({
            from: side(row.side),
            threadId: text(row, 'threadId'),
        }));
    }

    async remove(from: SnapshotSide, messageId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `DELETE FROM ${this.table} WHERE side = $1 AND "messageId" = $2 RETURNING id`,
            { bind: [from, messageId], type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    async failed(from: SnapshotSide, messageId: string): Promise<number> {
        const rows = await this.db.query<Row>(
            `UPDATE ${this.table} SET failures = failures + 1
             WHERE side = $1 AND "messageId" = $2 RETURNING failures`,
            { bind: [from, messageId], type: QueryTypes.SELECT }
        );
        const failures = rows[0]?.failures;
        return typeof failures === 'number' ? failures : 0;
    }

    async expire(before: number): Promise<void> {
        await this.db.query(
            `DELETE FROM ${this.table} WHERE "createdAt" < $1`,
            { bind: [new Date(before)] }
        );
    }
}

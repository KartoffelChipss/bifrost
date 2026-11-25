import { randomUUID } from 'node:crypto';
import { QueryTypes, type Sequelize } from 'sequelize';
import type { SnapshotSide } from '../addons/db/schema';
import { TABLES } from '../addons/db/schema';

export type Side = SnapshotSide;

export interface AccountPair {
    readonly discordUserId: string;
    readonly fluxerUserId: string;
}

/** A link that waits for the code owner's yes. */
export interface PendingLink extends AccountPair {
    readonly confirmSide: Side;
    readonly confirmUserId: string;
    readonly expiresAt: Date;
}

/** The database access account linking needs. */
export interface IdentityStore {
    pairFor(side: Side, userId: string): Promise<AccountPair | null>;
    savePair(pair: AccountPair, now: Date): Promise<void>;
    deletePair(side: Side, userId: string): Promise<AccountPair | null>;
    /** Every linked pair, for the role sweep. */
    listPairs(): Promise<AccountPair[]>;
    saveCode(
        hash: string,
        side: Side,
        userId: string,
        expiresAt: Date
    ): Promise<void>;
    /** Uses a code once. Only an unused, unexpired code from `side` counts. */
    takeCode(hash: string, side: Side, now: Date): Promise<string | null>;
    savePending(pending: PendingLink): Promise<void>;
    /** Removes and returns the pending link this user must confirm. */
    takePending(
        side: Side,
        userId: string,
        now: Date
    ): Promise<PendingLink | null>;
    recordFailure(side: Side, userId: string, now: Date): Promise<void>;
    failuresSince(side: Side, userId: string, since: Date): Promise<number>;
}

export class IdentityDataError extends Error {}

type Row = Record<string, unknown>;

const column = (side: Side) =>
    side === 'discord' ? 'discordUserId' : 'fluxerUserId';

function parsePair(row: Row): AccountPair {
    if (
        typeof row.discordUserId !== 'string' ||
        typeof row.fluxerUserId !== 'string'
    ) {
        throw new IdentityDataError('account pair is malformed');
    }
    return { discordUserId: row.discordUserId, fluxerUserId: row.fluxerUserId };
}

/** Upper bound on linked pairs read by one sweep. */
export const MAX_PAIRS = 10_000;

export class PostgresIdentityStore implements IdentityStore {
    constructor(private readonly db: Sequelize) {
        if (db.getDialect() !== 'postgres') {
            throw new IdentityDataError('account linking needs Postgres');
        }
    }

    async pairFor(side: Side, userId: string): Promise<AccountPair | null> {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.identityLinks} WHERE "${column(side)}" = $1`,
            { bind: [userId], type: QueryTypes.SELECT }
        );
        return rows[0] ? parsePair(rows[0]) : null;
    }

    async savePair(pair: AccountPair, now: Date): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.identityLinks} ("discordUserId", "fluxerUserId", "linkedAt") VALUES ($1, $2, $3)`,
            { bind: [pair.discordUserId, pair.fluxerUserId, now] }
        );
    }

    async deletePair(side: Side, userId: string): Promise<AccountPair | null> {
        const pair = await this.pairFor(side, userId);
        if (!pair) return null;
        await this.db.query(
            `DELETE FROM ${TABLES.identityLinks} WHERE "discordUserId" = $1`,
            { bind: [pair.discordUserId] }
        );
        return pair;
    }

    async listPairs(): Promise<AccountPair[]> {
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.identityLinks} ORDER BY "linkedAt" LIMIT $1`,
            { bind: [MAX_PAIRS], type: QueryTypes.SELECT }
        );
        return rows.map(parsePair);
    }

    async saveCode(hash: string, side: Side, userId: string, expiresAt: Date) {
        await this.db.query(
            `INSERT INTO ${TABLES.identityCodes} ("codeHash", side, "userId", "expiresAt") VALUES ($1, $2, $3, $4)`,
            { bind: [hash, side, userId, expiresAt] }
        );
    }

    async takeCode(
        hash: string,
        side: Side,
        now: Date
    ): Promise<string | null> {
        const rows = await this.db.query<Row>(
            `UPDATE ${TABLES.identityCodes} SET "usedAt" = $3
             WHERE "codeHash" = $1 AND side = $2 AND "usedAt" IS NULL AND "expiresAt" > $3
             RETURNING "userId"`,
            { bind: [hash, side, now], type: QueryTypes.SELECT }
        );
        const userId = rows[0]?.userId;
        return typeof userId === 'string' ? userId : null;
    }

    async savePending(pending: PendingLink): Promise<void> {
        await this.db.query(
            `DELETE FROM ${TABLES.identityPending} WHERE "confirmSide" = $1 AND "confirmUserId" = $2`,
            { bind: [pending.confirmSide, pending.confirmUserId] }
        );
        await this.db.query(
            `INSERT INTO ${TABLES.identityPending} (id, "discordUserId", "fluxerUserId", "confirmSide", "confirmUserId", "expiresAt")
             VALUES ($1, $2, $3, $4, $5, $6)`,
            {
                bind: [
                    randomUUID(),
                    pending.discordUserId,
                    pending.fluxerUserId,
                    pending.confirmSide,
                    pending.confirmUserId,
                    pending.expiresAt,
                ],
            }
        );
    }

    async takePending(
        side: Side,
        userId: string,
        now: Date
    ): Promise<PendingLink | null> {
        const rows = await this.db.query<Row>(
            `DELETE FROM ${TABLES.identityPending} WHERE "confirmSide" = $1 AND "confirmUserId" = $2
             RETURNING "discordUserId", "fluxerUserId", "confirmSide", "confirmUserId", "expiresAt"`,
            { bind: [side, userId], type: QueryTypes.SELECT }
        );
        const row = rows[0];
        if (!row || !(row.expiresAt instanceof Date) || row.expiresAt <= now)
            return null;
        return {
            ...parsePair(row),
            confirmSide: side,
            confirmUserId: userId,
            expiresAt: row.expiresAt,
        };
    }

    async recordFailure(side: Side, userId: string, now: Date): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.identityFailures} (side, "userId", at) VALUES ($1, $2, $3)`,
            { bind: [side, userId, now] }
        );
    }

    async failuresSince(
        side: Side,
        userId: string,
        since: Date
    ): Promise<number> {
        const [row] = await this.db.query<{ count: string }>(
            `SELECT count(*) AS count FROM ${TABLES.identityFailures} WHERE side = $1 AND "userId" = $2 AND at >= $3`,
            { bind: [side, userId, since], type: QueryTypes.SELECT }
        );
        const count = Number(row?.count);
        if (!Number.isInteger(count))
            throw new IdentityDataError('failure count is not a number');
        return count;
    }
}

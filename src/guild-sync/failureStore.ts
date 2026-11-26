import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../addons/db/schema';
import type { FailureCountStore } from './failures';

/** Counts older than this are forgotten when read back. */
export const FAILURE_COUNT_TTL_DAYS = 7;
/** Longest op key stored; longer keys are not saved. */
const MAX_KEY_LENGTH = 300;

/** Failure counts in Postgres (migration 00014). */
export class PostgresFailureCountStore implements FailureCountStore {
    constructor(private readonly db: Sequelize) {}

    async loadFailureCounts(
        limit: number
    ): Promise<readonly { key: string; count: number }[]> {
        await this.db.query(
            `DELETE FROM ${TABLES.failureCounts} WHERE "updatedAt" < now() - make_interval(days => $1)`,
            { bind: [FAILURE_COUNT_TTL_DAYS] }
        );
        const rows = await this.db.query<{ key: string; count: number }>(
            `SELECT key, count FROM ${TABLES.failureCounts} ORDER BY "updatedAt" DESC LIMIT $1`,
            { bind: [limit], type: QueryTypes.SELECT }
        );
        return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
    }

    async saveFailureCount(key: string, count: number, now: Date) {
        if (key.length > MAX_KEY_LENGTH) return;
        await this.db.query(
            `INSERT INTO ${TABLES.failureCounts} (key, count, "updatedAt") VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, "updatedAt" = EXCLUDED."updatedAt"`,
            { bind: [key, count, now] }
        );
    }

    async clearFailureCount(key: string) {
        await this.db.query(
            `DELETE FROM ${TABLES.failureCounts} WHERE key = $1`,
            { bind: [key] }
        );
    }
}

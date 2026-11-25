import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * History jobs survive brief trouble.
 * - `retries` counts temporary errors in a row (5xx, 429, timeouts); they
 *   never fail a job.
 * - `retryAt` is the earliest time the job runs again, for backoff.
 * - `skipped` counts messages given up on after repeated lasting errors.
 * - A message's `contentHash` lets crash recovery tell its copy from other
 *   posts by the same webhook, such as live relay messages.
 * - `archiveThreadId` is the Fluxer thread a big channel's history goes to
 *   in archive-thread mode (BF_HISTORY_INLINE_MAX).
 */

const counter = {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
} as const;

const JOB_COLUMNS = {
    retries: counter,
    retryAt: { type: DataTypes.DATE, allowNull: true },
    skipped: counter,
    archiveThreadId: { type: DataTypes.STRING, allowNull: true },
} as const;

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        for (const [name, spec] of Object.entries(JOB_COLUMNS)) {
            await qi.addColumn(TABLES.historyJobs, name, spec, {
                transaction,
            });
        }
        await qi.addColumn(
            TABLES.historyMessages,
            'contentHash',
            { type: DataTypes.STRING, allowNull: true },
            { transaction }
        );
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        await qi.removeColumn(TABLES.historyMessages, 'contentHash', {
            transaction,
        });
        for (const name of Object.keys(JOB_COLUMNS)) {
            await qi.removeColumn(TABLES.historyJobs, name, { transaction });
        }
    });
}

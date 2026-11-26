import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * History jobs remember what their errors are about.
 * - `streakFromId` is the checkpoint from before the first skip of the
 *   current skip streak. A job that fails mid-streak moves its checkpoint
 *   back there, so a retry copies the skipped messages again.
 * - `failingId` is what `failures` and `retries` count against: a Discord
 *   message ID, or 'target' for errors outside any one message. Counts
 *   start over when it changes (history/importer.ts onError).
 */
const JOB_COLUMNS = ['streakFromId', 'failingId'] as const;

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        for (const name of JOB_COLUMNS) {
            await qi.addColumn(
                TABLES.historyJobs,
                name,
                { type: DataTypes.STRING, allowNull: true },
                { transaction }
            );
        }
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        for (const name of JOB_COLUMNS) {
            await qi.removeColumn(TABLES.historyJobs, name, { transaction });
        }
    });
}

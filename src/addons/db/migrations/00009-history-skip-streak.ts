import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * `skipStreak` counts messages a history job skipped in a row. A run of
 * skips means the trouble is not with the messages, so the job fails at
 * MAX_SKIP_STREAK (history/importer.ts) instead of skipping them all.
 */
const COLUMN = 'skipStreak';

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.addColumn(TABLES.historyJobs, COLUMN, {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.removeColumn(TABLES.historyJobs, COLUMN);
}

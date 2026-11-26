import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * Failure counts of guild-sync writes that keep failing, so a restart
 * keeps them (failures.ts StoredFailureLedger). One row per op key.
 */
export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.createTable(TABLES.failureCounts, {
        key: { type: DataTypes.STRING(300), primaryKey: true },
        count: { type: DataTypes.INTEGER, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await qi.addIndex(TABLES.failureCounts, ['updatedAt']);
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.dropTable(TABLES.failureCounts);
}

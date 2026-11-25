import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * `appliedFields` holds the field values the last successful write gave a
 * mapped object. The diff compares the source against it: a difference
 * means the source moved, and anything else that differs on the
 * destination was edited there. Rows written before this column have NULL.
 */
const COLUMN = 'appliedFields';

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.addColumn(TABLES.objectMap, COLUMN, {
        type: DataTypes.JSONB,
        allowNull: true,
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.removeColumn(TABLES.objectMap, COLUMN);
}

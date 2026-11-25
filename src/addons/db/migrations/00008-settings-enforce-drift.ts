import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * `enforceDrift`: when on, guild-sync reverts Fluxer edits to the fields
 * it manages instead of only reporting them as drift. Off by default, so
 * existing links keep their behaviour.
 */
const COLUMN = 'enforceDrift';

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.addColumn(TABLES.settings, COLUMN, {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.removeColumn(TABLES.settings, COLUMN);
}

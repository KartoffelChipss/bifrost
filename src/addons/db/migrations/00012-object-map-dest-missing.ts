import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * Counts consecutive healthy checks in which a mapped copy was absent from
 * the destination, apart from `missingCount`, which counts absence from
 * the source for removals. A copy the sync created that stays missing
 * past the confirmation thresholds is restored (guild-sync restore.ts).
 * Existing rows start at 0 and NULL: nothing counts as missing yet.
 */
const COUNT = 'destMissingCount';
const SINCE = 'destMissingSince';
const CHECK = `${TABLES.objectMap}_dest_missing_count_check`;

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        await qi.addColumn(
            TABLES.objectMap,
            COUNT,
            { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            { transaction }
        );
        await qi.addColumn(
            TABLES.objectMap,
            SINCE,
            { type: DataTypes.DATE, allowNull: true },
            { transaction }
        );
        await qi.sequelize.query(
            `ALTER TABLE "${TABLES.objectMap}" ADD CONSTRAINT "${CHECK}" CHECK ("${COUNT}" >= 0)`,
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
        await qi.sequelize.query(
            `ALTER TABLE "${TABLES.objectMap}" DROP CONSTRAINT IF EXISTS "${CHECK}"`,
            { transaction }
        );
        await qi.removeColumn(TABLES.objectMap, SINCE, { transaction });
        await qi.removeColumn(TABLES.objectMap, COUNT, { transaction });
    });
}

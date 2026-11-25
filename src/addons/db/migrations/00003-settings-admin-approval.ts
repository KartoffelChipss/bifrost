import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * Two per-link settings for the approval flow:
 * - `adminChannelId`: the private source-side channel that plans are
 *   posted to and admin commands are accepted in.
 * - `approvedPlanId`: the pending plan an admin approved. It is used once.
 */
const COLUMNS = {
    adminChannelId: { type: DataTypes.STRING, allowNull: true },
    approvedPlanId: { type: DataTypes.UUID, allowNull: true },
} as const;

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        for (const [name, column] of Object.entries(COLUMNS)) {
            await qi.addColumn(TABLES.settings, name, column, { transaction });
        }
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        for (const name of Object.keys(COLUMNS)) {
            await qi.removeColumn(TABLES.settings, name, { transaction });
        }
    });
}

import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * The live status message guild-sync keeps in the admin channel. Saving
 * its channel and message IDs lets a restart edit the same message instead
 * of posting a new one. Both are null until the first status is posted.
 */
const COLUMNS = ['statusChannelId', 'statusMessageId'] as const;

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        for (const name of COLUMNS) {
            await qi.addColumn(
                TABLES.settings,
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
        for (const name of COLUMNS) {
            await qi.removeColumn(TABLES.settings, name, { transaction });
        }
    });
}

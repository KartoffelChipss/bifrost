import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * Native history copies and name sync (docs/design/history-rewrite.md).
 *
 * - history_messages.native: true once the rewrite job gave the copy its
 *   Discord message ID and removed the date and reactions lines. The
 *   formatter then builds edits without those lines.
 * - history_messages.nativeReply: true when the rewrite made the copy a
 *   Fluxer reply, so edits leave out the reply quote.
 * - history_messages.formerFluxerMessageId: the copy's ID before the
 *   rewrite, kept for checks and support.
 * - name_sync: the name last applied to each author's Fluxer copies, per
 *   Discord server, and whether a change is waiting.
 */
export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        const history = TABLES.historyMessages;
        const flag = {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        };
        await qi.addColumn(history, 'native', flag, { transaction });
        await qi.addColumn(history, 'nativeReply', flag, { transaction });
        await qi.addColumn(
            history,
            'formerFluxerMessageId',
            { type: DataTypes.TEXT, allowNull: true },
            { transaction }
        );
        await qi.addIndex(history, ['discordAuthorId'], {
            transaction,
            name: `${history}_author`,
        });
        await qi.createTable(
            TABLES.nameSync,
            {
                guildId: { type: DataTypes.STRING, primaryKey: true },
                discordUserId: { type: DataTypes.STRING, primaryKey: true },
                appliedName: { type: DataTypes.TEXT, allowNull: true },
                dirty: {
                    type: DataTypes.BOOLEAN,
                    allowNull: false,
                    defaultValue: true,
                },
                failures: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                    defaultValue: 0,
                },
                appliedAt: { type: DataTypes.DATE, allowNull: true },
            },
            { transaction }
        );
        await qi.addIndex(TABLES.nameSync, ['guildId', 'dirty'], {
            transaction,
            name: `${TABLES.nameSync}_due`,
        });
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        const history = TABLES.historyMessages;
        await qi.dropTable(TABLES.nameSync, { transaction });
        await qi.removeIndex(history, `${history}_author`, { transaction });
        for (const column of [
            'formerFluxerMessageId',
            'nativeReply',
            'native',
        ]) {
            await qi.removeColumn(history, column, { transaction });
        }
    });
}

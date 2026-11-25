import { DataTypes, type QueryInterface } from 'sequelize';
import { TABLES } from '../schema';

/**
 * `addon_parked_messages`: thread replies the thread relay holds until
 * their thread exists on the other side or its history is copied. Kept in
 * the database so a restart does not lose them. Only the address is kept;
 * the relay fetches the message again when it sends it.
 */

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    const table = TABLES.parkedMessages;
    await qi.sequelize.transaction(async (transaction) => {
        await qi.createTable(
            table,
            {
                id: {
                    type: DataTypes.BIGINT,
                    primaryKey: true,
                    autoIncrement: true,
                },
                side: { type: DataTypes.STRING, allowNull: false },
                messageId: { type: DataTypes.STRING, allowNull: false },
                threadId: { type: DataTypes.STRING, allowNull: false },
                parentId: { type: DataTypes.STRING, allowNull: false },
                webhookId: { type: DataTypes.STRING, allowNull: true },
                failures: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                    defaultValue: 0,
                },
                createdAt: { type: DataTypes.DATE, allowNull: false },
            },
            { transaction }
        );
        await qi.sequelize.query(
            `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_side_check" CHECK (side IN ('discord', 'fluxer'))`,
            { transaction }
        );
        await qi.addIndex(table, ['side', 'messageId'], {
            transaction,
            unique: true,
            name: `${table}_message_unique`,
        });
        await qi.addIndex(table, ['side', 'threadId', 'id'], {
            transaction,
            name: `${table}_thread`,
        });
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.dropTable(TABLES.parkedMessages);
}

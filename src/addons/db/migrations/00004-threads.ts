import { DataTypes, type QueryInterface, type Transaction } from 'sequelize';
import { TABLES } from '../schema';

/**
 * Threads and forum posts become synced objects.
 * - `thread` joins the allowed object kinds in the object map and the
 *   audit log.
 * - `addon_thread_messages` pairs the two copies of a message relayed
 *   inside a thread. Upstream's `message_links` has no thread column, so
 *   its edit and delete handlers cannot address a message in a thread.
 */

const KINDS_BEFORE = [
    'guild',
    'role',
    'category',
    'channel',
    'overwrite',
    'emoji',
    'sticker',
];
const KINDS_AFTER = [...KINDS_BEFORE, 'thread'];
const KIND_TABLES = [TABLES.objectMap, TABLES.auditLog];

async function setKinds(
    qi: QueryInterface,
    transaction: Transaction,
    kinds: readonly string[]
): Promise<void> {
    for (const table of KIND_TABLES) {
        const name = `${table}_kind_check`;
        await qi.removeConstraint(table, name, { transaction });
        await qi.addConstraint(table, {
            type: 'check',
            name,
            fields: ['kind'],
            where: { kind: [...kinds] },
            transaction,
        });
    }
}

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        await setKinds(qi, transaction, KINDS_AFTER);
        const table = TABLES.threadMessages;
        await qi.createTable(
            table,
            {
                id: {
                    type: DataTypes.BIGINT,
                    primaryKey: true,
                    autoIncrement: true,
                },
                guildLinkId: {
                    type: DataTypes.UUID,
                    allowNull: false,
                    references: { model: 'guild_links', key: 'id' },
                    onDelete: 'CASCADE',
                },
                discordThreadId: { type: DataTypes.STRING, allowNull: false },
                fluxerThreadId: { type: DataTypes.STRING, allowNull: false },
                discordMessageId: { type: DataTypes.STRING, allowNull: false },
                fluxerMessageId: { type: DataTypes.STRING, allowNull: false },
                createdAt: { type: DataTypes.DATE, allowNull: false },
            },
            { transaction }
        );
        for (const column of ['discordMessageId', 'fluxerMessageId']) {
            await qi.addIndex(table, [column], {
                transaction,
                unique: true,
                name: `${table}_${column}_unique`,
            });
        }
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        await qi.dropTable(TABLES.threadMessages, { transaction });
        await setKinds(qi, transaction, KINDS_BEFORE);
    });
}

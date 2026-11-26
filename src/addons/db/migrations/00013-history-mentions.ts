import { DataTypes, type QueryInterface, type Transaction } from 'sequelize';
import { TABLES } from '../schema';

/**
 * Re-renders imported copies when a member links accounts later.
 *
 * - `mentionsRecorded` on each imported message: true once the Discord
 *   users its source mentions are recorded. Rows imported before this
 *   migration start false, and a background pass reads their sources
 *   back from Discord (history/backfill.ts).
 * - The mentions table: one row per imported message and mentioned
 *   Discord user, found by user for the fix-up.
 * - The fix-ups table: per guild link and linked member, how far the
 *   re-render of their mentions has got (history/fixup.ts). `linkedAt`
 *   is the link it ran for; a newer link starts it over.
 */
const RECORDED = 'mentionsRecorded';
const STATUSES = `('pending', 'previewed', 'done')`;

async function createMentions(qi: QueryInterface, transaction: Transaction) {
    const table = TABLES.historyMentions;
    await qi.createTable(
        table,
        {
            discordMessageId: {
                type: DataTypes.STRING,
                primaryKey: true,
                references: {
                    model: TABLES.historyMessages,
                    key: 'discordMessageId',
                },
                onDelete: 'CASCADE',
            },
            discordUserId: { type: DataTypes.STRING, primaryKey: true },
        },
        { transaction }
    );
    await qi.addIndex(table, ['discordUserId', 'discordMessageId'], {
        transaction,
        name: `${table}_user`,
    });
}

async function createFixups(qi: QueryInterface, transaction: Transaction) {
    const table = TABLES.mentionFixups;
    const count = {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    };
    await qi.createTable(
        table,
        {
            guildLinkId: {
                type: DataTypes.UUID,
                primaryKey: true,
                references: { model: 'guild_links', key: 'id' },
                onDelete: 'CASCADE',
            },
            discordUserId: { type: DataTypes.STRING, primaryKey: true },
            linkedAt: { type: DataTypes.DATE, allowNull: false },
            status: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: 'pending',
            },
            doneTo: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: '0',
            },
            changed: count,
            failures: count,
            notBefore: { type: DataTypes.DATE, allowNull: false },
            updatedAt: { type: DataTypes.DATE, allowNull: false },
        },
        { transaction }
    );
    await qi.sequelize.query(
        `ALTER TABLE "${table}"
         ADD CONSTRAINT "${table}_status_check" CHECK (status IN ${STATUSES}),
         ADD CONSTRAINT "${table}_counts_check" CHECK (changed >= 0 AND failures >= 0)`,
        { transaction }
    );
}

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        await qi.addColumn(
            TABLES.historyMessages,
            RECORDED,
            { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            { transaction }
        );
        await qi.sequelize.query(
            `CREATE INDEX "${TABLES.historyMessages}_unrecorded" ON "${TABLES.historyMessages}" ("jobId") WHERE "${RECORDED}" = false`,
            { transaction }
        );
        await createMentions(qi, transaction);
        await createFixups(qi, transaction);
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        await qi.dropTable(TABLES.mentionFixups, { transaction });
        await qi.dropTable(TABLES.historyMentions, { transaction });
        await qi.sequelize.query(
            `DROP INDEX IF EXISTS "${TABLES.historyMessages}_unrecorded"`,
            { transaction }
        );
        await qi.removeColumn(TABLES.historyMessages, RECORDED, {
            transaction,
        });
    });
}

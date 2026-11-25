import { DataTypes, type QueryInterface, type Transaction } from 'sequelize';
import { TABLES } from '../schema';

/**
 * Tables for the history and identity add-ons.
 *
 * History: one job per Discord channel or thread whose past messages are
 * copied, each imported message (so a restart never posts it twice, and a
 * linked member can edit it later), and the members who opted out.
 *
 * Identity: one-time link codes (hashed), links that wait for the code
 * owner's yes, confirmed account pairs, and failed attempts for the lock.
 */

const guildLinkRef = {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'guild_links', key: 'id' },
    onDelete: 'CASCADE',
} as const;

const created = { type: DataTypes.DATE, allowNull: false } as const;
const text = (allowNull: boolean) => ({ type: DataTypes.STRING, allowNull });

async function createHistoryJobs(qi: QueryInterface, transaction: Transaction) {
    const table = TABLES.historyJobs;
    await qi.createTable(
        table,
        {
            id: { type: DataTypes.UUID, primaryKey: true },
            guildLinkId: guildLinkRef,
            kind: text(false),
            discordId: text(false),
            parentDiscordId: text(true),
            fluxerId: text(true),
            status: text(false),
            cutoffId: text(true),
            checkpointId: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: '0',
            },
            catchUps: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            imported: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            failures: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            messageCount: { type: DataTypes.INTEGER, allowNull: true },
            attachmentCount: { type: DataTypes.INTEGER, allowNull: true },
            surveyedAt: { type: DataTypes.DATE, allowNull: true },
            importWebhookId: text(true),
            importWebhookToken: text(true),
            lastError: { type: DataTypes.TEXT, allowNull: true },
            createdAt: created,
            updatedAt: created,
        },
        { transaction }
    );
    await qi.sequelize.query(
        `ALTER TABLE "${table}"
         ADD CONSTRAINT "${table}_kind_check" CHECK (kind IN ('channel', 'thread')),
         ADD CONSTRAINT "${table}_status_check" CHECK (status IN ('pending', 'importing', 'ready', 'done', 'failed'))`,
        { transaction }
    );
    await qi.addIndex(table, ['guildLinkId', 'kind', 'discordId'], {
        transaction,
        unique: true,
        name: `${table}_source_unique`,
    });
}

async function createHistoryMessages(
    qi: QueryInterface,
    transaction: Transaction
) {
    const table = TABLES.historyMessages;
    await qi.createTable(
        table,
        {
            discordMessageId: { type: DataTypes.STRING, primaryKey: true },
            jobId: {
                type: DataTypes.UUID,
                allowNull: false,
                references: { model: TABLES.historyJobs, key: 'id' },
                onDelete: 'CASCADE',
            },
            discordAuthorId: text(false),
            fluxerMessageId: text(true),
            /** The Fluxer channel or thread the copy is in. */
            fluxerTargetId: text(false),
            /** Set when the target is a thread inside `fluxerTargetId`'s parent. */
            inThread: { type: DataTypes.BOOLEAN, allowNull: false },
            webhookId: text(false),
            createdAt: created,
        },
        { transaction }
    );
    await qi.addIndex(table, ['fluxerMessageId'], {
        transaction,
        unique: true,
        name: `${table}_fluxer_unique`,
    });
    await qi.addIndex(table, ['jobId'], { transaction, name: `${table}_job` });
}

async function createIdentityTables(
    qi: QueryInterface,
    transaction: Transaction
) {
    await qi.createTable(
        TABLES.historyOptOuts,
        {
            discordUserId: { type: DataTypes.STRING, primaryKey: true },
            createdAt: created,
        },
        { transaction }
    );
    await qi.createTable(
        TABLES.identityLinks,
        {
            discordUserId: { type: DataTypes.STRING, primaryKey: true },
            fluxerUserId: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: true,
            },
            linkedAt: created,
        },
        { transaction }
    );
    await qi.createTable(
        TABLES.identityCodes,
        {
            codeHash: { type: DataTypes.STRING, primaryKey: true },
            side: text(false),
            userId: text(false),
            expiresAt: created,
            usedAt: { type: DataTypes.DATE, allowNull: true },
        },
        { transaction }
    );
    await qi.createTable(
        TABLES.identityPending,
        {
            id: { type: DataTypes.UUID, primaryKey: true },
            discordUserId: text(false),
            fluxerUserId: text(false),
            /** The code owner, who must reply yes. */
            confirmSide: text(false),
            confirmUserId: text(false),
            expiresAt: created,
        },
        { transaction }
    );
    await qi.addIndex(
        TABLES.identityPending,
        ['confirmSide', 'confirmUserId'],
        {
            transaction,
            name: `${TABLES.identityPending}_confirm`,
        }
    );
    await qi.createTable(
        TABLES.identityFailures,
        {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true,
            },
            side: text(false),
            userId: text(false),
            at: created,
        },
        { transaction }
    );
    await qi.addIndex(TABLES.identityFailures, ['side', 'userId', 'at'], {
        transaction,
        name: `${TABLES.identityFailures}_user_at`,
    });
    for (const table of [
        TABLES.identityCodes,
        TABLES.identityPending,
        TABLES.identityFailures,
    ]) {
        await qi.sequelize.query(
            `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_side_check" CHECK (${table === TABLES.identityPending ? '"confirmSide"' : 'side'} IN ('discord', 'fluxer'))`,
            { transaction }
        );
    }
}

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        await createHistoryJobs(qi, transaction);
        await createHistoryMessages(qi, transaction);
        await createIdentityTables(qi, transaction);
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    const order = [
        TABLES.identityFailures,
        TABLES.identityPending,
        TABLES.identityCodes,
        TABLES.identityLinks,
        TABLES.historyOptOuts,
        TABLES.historyMessages,
        TABLES.historyJobs,
    ];
    await qi.sequelize.transaction(async (transaction) => {
        for (const table of order) await qi.dropTable(table, { transaction });
    });
}

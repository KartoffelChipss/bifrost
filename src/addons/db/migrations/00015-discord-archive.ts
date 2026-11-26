import { DataTypes, type QueryInterface, type Transaction } from 'sequelize';
import { TABLES } from '../schema';

/**
 * The Discord archive (src/archive): a local copy of every archived
 * channel's messages as Discord's API returned them, a snapshot of each
 * author, and the files those messages carry. It lets history be reworked
 * later without reading Discord again, and keeps it if Discord goes away.
 *
 * - archive_channels: one row per channel or thread walked, with how far
 *   the walk got (afterId) and its counts.
 * - archive_messages: one row per message. `raw` is the API message JSON;
 *   null when the author opted out of history (`redacted`).
 * - archive_members: the latest name and avatar seen per guild member.
 * - archive_files: one row per attachment or sticker image, with the
 *   SHA-256 of the stored bytes (content-addressed on disk).
 */
export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        await createChannels(qi, transaction);
        await createMessages(qi, transaction);
        await createMembers(qi, transaction);
        await createFiles(qi, transaction);
    });
}

const text = (allowNull: boolean) => ({ type: DataTypes.TEXT, allowNull });
const count = { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 };
const date = (allowNull: boolean) => ({ type: DataTypes.DATE, allowNull });

async function createChannels(qi: QueryInterface, transaction: Transaction) {
    const table = TABLES.archiveChannels;
    await qi.createTable(
        table,
        {
            channelId: { type: DataTypes.STRING, primaryKey: true },
            guildId: text(false),
            /** 'channel' or 'thread'. */
            kind: text(false),
            parentId: text(true),
            /** The newest message archived; the walk goes on after it. */
            afterId: text(false),
            /** 'walking', 'current', 'failed' or 'forbidden'. */
            status: text(false),
            messages: count,
            failures: count,
            lastError: text(true),
            walkedAt: date(true),
            updatedAt: date(false),
        },
        { transaction }
    );
    await qi.addIndex(table, ['guildId', 'status'], {
        transaction,
        name: `${table}_guild_status`,
    });
}

async function createMessages(qi: QueryInterface, transaction: Transaction) {
    const table = TABLES.archiveMessages;
    await qi.createTable(
        table,
        {
            messageId: { type: DataTypes.STRING, primaryKey: true },
            channelId: text(false),
            guildId: text(false),
            authorId: text(false),
            createdAt: date(false),
            editedAt: date(true),
            raw: { type: DataTypes.JSONB, allowNull: true },
            redacted: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            fetchedAt: date(false),
        },
        { transaction }
    );
    await qi.addIndex(table, ['channelId', 'messageId'], {
        transaction,
        name: `${table}_channel`,
    });
    await qi.addIndex(table, ['authorId'], {
        transaction,
        name: `${table}_author`,
    });
}

async function createMembers(qi: QueryInterface, transaction: Transaction) {
    const table = TABLES.archiveMembers;
    await qi.createTable(
        table,
        {
            guildId: { type: DataTypes.STRING, primaryKey: true },
            userId: { type: DataTypes.STRING, primaryKey: true },
            username: text(false),
            globalName: text(true),
            /** Null when the member has no nickname, or has left. */
            nick: text(true),
            avatar: text(true),
            serverAvatar: text(true),
            /** False when Discord said they are no longer a member. */
            inGuild: { type: DataTypes.BOOLEAN, allowNull: false },
            seenAt: date(false),
        },
        { transaction }
    );
}

async function createFiles(qi: QueryInterface, transaction: Transaction) {
    const table = TABLES.archiveFiles;
    await qi.createTable(
        table,
        {
            /** 'attachment' or 'sticker'. */
            kind: { type: DataTypes.STRING(16), primaryKey: true },
            sourceId: { type: DataTypes.STRING, primaryKey: true },
            messageId: text(false),
            filename: text(false),
            size: { type: DataTypes.BIGINT, allowNull: true },
            contentType: text(true),
            sha256: { type: DataTypes.STRING(64), allowNull: true },
            /** 'pending', 'stored', 'gone' or 'failed'. */
            status: text(false),
            failures: count,
            updatedAt: date(false),
        },
        { transaction }
    );
    await qi.addIndex(table, ['messageId'], {
        transaction,
        name: `${table}_message`,
    });
    await qi.addIndex(table, ['status'], {
        transaction,
        name: `${table}_status`,
    });
    await qi.addIndex(table, ['sha256'], {
        transaction,
        name: `${table}_sha256`,
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    await qi.sequelize.transaction(async (transaction) => {
        for (const table of [
            TABLES.archiveFiles,
            TABLES.archiveMembers,
            TABLES.archiveMessages,
            TABLES.archiveChannels,
        ]) {
            await qi.dropTable(table, { transaction });
        }
    });
}

import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('guild_links', {
        id: { type: DataTypes.UUID, primaryKey: true },
        discordGuildId: { type: DataTypes.STRING, unique: true },
        fluxerGuildId: { type: DataTypes.STRING, unique: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    await queryInterface.createTable('channel_links', {
        id: { type: DataTypes.UUID, primaryKey: true },
        guildLinkId: { type: DataTypes.UUID },
        discordChannelId: { type: DataTypes.STRING, allowNull: false },
        fluxerChannelId: { type: DataTypes.STRING, allowNull: false },
        discordWebhookId: { type: DataTypes.STRING, allowNull: false },
        discordWebhookToken: { type: DataTypes.STRING, allowNull: false },
        fluxerWebhookId: { type: DataTypes.STRING, allowNull: false },
        fluxerWebhookToken: { type: DataTypes.STRING, allowNull: false },
        linkId: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    await queryInterface.createTable('message_links', {
        id: { type: DataTypes.UUID, primaryKey: true },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'guild_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        channelLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'channel_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        discordMessageId: { type: DataTypes.STRING, allowNull: false },
        fluxerMessageId: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex('message_links', ['discordMessageId'], {
        unique: true,
        name: 'message_links_discord_message_id',
    });
    await queryInterface.addIndex('message_links', ['fluxerMessageId'], {
        unique: true,
        name: 'message_links_fluxer_message_id',
    });
    await queryInterface.addIndex('message_links', ['guildLinkId'], {
        name: 'message_links_guild_link_id',
    });

    await queryInterface.createTable('queued_messages', {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
            defaultValue: DataTypes.UUIDV4,
        },
        direction: { type: DataTypes.STRING, allowNull: false },
        channelLinkId: { type: DataTypes.UUID, allowNull: false },
        sourceMessageId: { type: DataTypes.STRING, allowNull: false },
        payload: { type: DataTypes.TEXT, allowNull: false },
        retryCount: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        lastError: { type: DataTypes.TEXT, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
        'queued_messages',
        ['direction', 'createdAt'],
        {
            name: 'queued_messages_direction_created_at',
        }
    );
};

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.dropTable('queued_messages');
    await queryInterface.dropTable('message_links');
    await queryInterface.dropTable('channel_links');
    await queryInterface.dropTable('guild_links');
};

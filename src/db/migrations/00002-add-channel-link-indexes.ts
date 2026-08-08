import type { Migration } from '../migrator';

export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.addIndex('channel_links', ['discordChannelId'], {
        unique: true,
        name: 'channel_links_discord_channel_id',
    });
    await queryInterface.addIndex('channel_links', ['fluxerChannelId'], {
        unique: true,
        name: 'channel_links_fluxer_channel_id',
    });
    await queryInterface.addIndex('channel_links', ['guildLinkId'], {
        name: 'channel_links_guild_link_id',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.removeIndex(
        'channel_links',
        'channel_links_discord_channel_id'
    );
    await queryInterface.removeIndex(
        'channel_links',
        'channel_links_fluxer_channel_id'
    );
    await queryInterface.removeIndex(
        'channel_links',
        'channel_links_guild_link_id'
    );
};

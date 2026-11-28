import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.addColumn('message_links', 'discordAuthorId', {
        type: DataTypes.STRING,
        allowNull: true,
    });
    await queryInterface.addColumn('message_links', 'discordAuthorUsername', {
        type: DataTypes.STRING,
        allowNull: true,
    });
    await queryInterface.addColumn('message_links', 'fluxerAuthorId', {
        type: DataTypes.STRING,
        allowNull: true,
    });
    await queryInterface.addColumn('message_links', 'fluxerAuthorUsername', {
        type: DataTypes.STRING,
        allowNull: true,
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.removeColumn('message_links', 'discordAuthorId');
    await queryInterface.removeColumn('message_links', 'discordAuthorUsername');
    await queryInterface.removeColumn('message_links', 'fluxerAuthorId');
    await queryInterface.removeColumn('message_links', 'fluxerAuthorUsername');
};

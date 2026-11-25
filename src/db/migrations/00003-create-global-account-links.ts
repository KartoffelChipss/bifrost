import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

const fields = [
    'discordAccountPresentationEnabled',
    'fluxerAccountPresentationEnabled',
];

export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
        await queryInterface.createTable(
            'global_account_links',
            {
                id: { type: DataTypes.UUID, primaryKey: true },
                discordUserId: { type: DataTypes.STRING, allowNull: false },
                fluxerUserId: { type: DataTypes.STRING, allowNull: false },
                createdAt: { type: DataTypes.DATE, allowNull: false },
            },
            { transaction }
        );
        for (const field of ['discordUserId', 'fluxerUserId']) {
            await queryInterface.addIndex('global_account_links', [field], {
                unique: true,
                transaction,
            });
        }
        for (const field of fields) {
            await queryInterface.addColumn(
                'guild_links',
                field,
                {
                    type: DataTypes.BOOLEAN,
                    allowNull: false,
                    defaultValue: false,
                },
                { transaction }
            );
        }
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
        for (const field of fields) {
            await queryInterface.removeColumn('guild_links', field, {
                transaction,
            });
        }
        await queryInterface.dropTable('global_account_links', { transaction });
    });
};

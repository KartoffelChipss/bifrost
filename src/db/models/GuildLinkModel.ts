import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class GuildLinkModel extends Model {}

GuildLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },
        discordAccountPresentationEnabled: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
        fluxerAccountPresentationEnabled: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
        discordGuildId: {
            type: DataTypes.STRING,
            unique: true,
        },
        fluxerGuildId: {
            type: DataTypes.STRING,
            unique: true,
        },
    },
    {
        sequelize,
        tableName: 'guild_links',
        createdAt: 'createdAt',
        updatedAt: false,
    }
);

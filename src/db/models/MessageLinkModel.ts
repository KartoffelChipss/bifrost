import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class MessageLinkModel extends Model {}

MessageLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: {
                model: 'guild_links',
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        channelLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: {
                model: 'channel_links',
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        discordMessageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        fluxerMessageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'message_links',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            {
                unique: true,
                fields: ['discordMessageId'],
            },
            {
                unique: true,
                fields: ['fluxerMessageId'],
            },
            {
                fields: ['guildLinkId'],
            },
        ],
    }
);

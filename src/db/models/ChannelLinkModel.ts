import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class ChannelLinkModel extends Model {}

ChannelLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },

        guildLinkId: {
            type: DataTypes.UUID,
        },

        discordChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        fluxerChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        discordWebhookId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        discordWebhookToken: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        fluxerWebhookId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        fluxerWebhookToken: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        linkId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    { sequelize, tableName: 'channel_links', createdAt: 'createdAt', updatedAt: false }
);

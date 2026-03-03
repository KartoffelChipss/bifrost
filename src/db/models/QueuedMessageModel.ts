import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class QueuedMessageModel extends Model {
    declare id: string;
    declare direction: 'discord_to_fluxer' | 'fluxer_to_discord';
    declare channelLinkId: string;
    declare sourceMessageId: string;
    declare payload: string;
    declare retryCount: number;
    declare lastError: string | null;
    declare createdAt: Date;
}

QueuedMessageModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
            defaultValue: DataTypes.UUIDV4,
        },
        direction: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        channelLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
        },
        sourceMessageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        payload: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        retryCount: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        lastError: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
    },
    {
        sequelize,
        tableName: 'queued_messages',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            {
                fields: ['direction', 'createdAt'],
            },
        ],
    }
);

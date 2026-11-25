import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class AccountLinkModel extends Model {
    declare id: string;
    declare discordUserId: string;
    declare fluxerUserId: string;
}

AccountLinkModel.init(
    {
        id: { type: DataTypes.UUID, primaryKey: true },
        discordUserId: { type: DataTypes.STRING, allowNull: false },
        fluxerUserId: { type: DataTypes.STRING, allowNull: false },
    },
    { sequelize, tableName: 'global_account_links', updatedAt: false }
);

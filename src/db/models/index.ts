import { GuildLinkModel } from './GuildLinkModel';
import { ChannelLinkModel } from './ChannelLinkModel';

GuildLinkModel.hasMany(ChannelLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'channelLinks',
    onDelete: 'CASCADE',
});

ChannelLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

export { GuildLinkModel, ChannelLinkModel };

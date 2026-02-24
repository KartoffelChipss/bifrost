import { ChannelLink } from '../entities/ChannelLink';

export interface ChannelLinkRepository {
    create(data: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        discordWebhookId: string;
        discordWebhookToken: string;
        fluxerWebhookId: string;
        fluxerWebhookToken: string;
    }): Promise<ChannelLink>;

    findByGuildAndLinkId(guildLinkId: string, linkId: string): Promise<ChannelLink | null>;

    findAllByGuild(guildLinkId: string): Promise<ChannelLink[]>;

    findById(id: string): Promise<ChannelLink | null>;

    findByDiscordChannelId(discordChannelId: string): Promise<ChannelLink | null>;

    findByFluxerChannelId(fluxerChannelId: string): Promise<ChannelLink | null>;

    deleteById(id: string): Promise<void>;
}

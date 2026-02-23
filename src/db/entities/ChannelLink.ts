export interface ChannelLink {
    id: string;
    guildLinkId: string;

    discordChannelId: string;
    fluxerChannelId: string;

    discordWebhookId: string;
    discordWebhookToken: string;

    fluxerWebhookId: string;
    fluxerWebhookToken: string;

    linkId: string;
    createdAt: Date;
}

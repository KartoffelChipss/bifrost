export interface MessageLink {
    id: string;
    guildLinkId: string;
    channelLinkId: string;

    discordMessageId: string;
    fluxerMessageId: string;

    createdAt: Date;
}

export interface MessageLink {
    id: string;
    guildLinkId: string;
    channelLinkId: string;

    discordMessageId: string;
    fluxerMessageId: string;

    discordAuthorId: string | null;
    discordAuthorUsername: string | null;
    fluxerAuthorId: string | null;
    fluxerAuthorUsername: string | null;

    createdAt: Date;
}

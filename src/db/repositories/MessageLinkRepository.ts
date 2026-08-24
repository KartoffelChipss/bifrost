import { MessageLink } from '../entities/MessageLink';

export interface MessageLinkRepository {
    createMessageLink(
        guildLinkId: string,
        channelLinkId: string,
        discordMessageId: string,
        fluxerMessageId: string,
        discordAuthorId?: string | null,
        discordAuthorUsername?: string | null,
        fluxerAuthorId?: string | null,
        fluxerAuthorUsername?: string | null
    ): Promise<void>;

    getMessageLinkById(id: string): Promise<MessageLink | null>;

    getMessageLinkByDiscordMessageId(
        discordMessageId: string
    ): Promise<MessageLink | null>;

    getMessageLinkByFluxerMessageId(
        fluxerMessageId: string
    ): Promise<MessageLink | null>;

    deleteMessageLink(id: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;

    deleteByChannelLinkId(channelLinkId: string): Promise<void>;

    getMessageLinksCount(): Promise<number>;
}

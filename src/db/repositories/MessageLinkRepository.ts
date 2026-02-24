import { MessageLink } from '../entities/MessageLink';

export interface MessageLinkRepository {
    createMessageLink(
        guildLinkId: string,
        channelLinkId: string,
        discordMessageId: string,
        fluxerMessageId: string
    ): Promise<void>;

    getMessageLinkById(id: string): Promise<MessageLink | null>;

    getMessageLinkByDiscordMessageId(discordMessageId: string): Promise<MessageLink | null>;

    getMessageLinkByFluxerMessageId(fluxerMessageId: string): Promise<MessageLink | null>;

    deleteMessageLink(id: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;
}

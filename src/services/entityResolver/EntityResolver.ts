export default interface EntityResolver<Guild, Channel, Message, Emoji> {
    fetchGuild(guildId: string): Promise<Guild | null>;
    fetchChannel(
        guildId: string | Guild,
        channelId: string
    ): Promise<Channel | null>;
    fetchMessage(
        guildId: string | Guild,
        channelId: string | Channel,
        messageId: string
    ): Promise<Message>;
    fetchEmojis(guildId: string | Guild): Promise<Emoji[]>;
}

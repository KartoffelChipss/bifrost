export default interface EntityResolver<G, C, M> {
    fetchGuild(guildId: string): Promise<G | null>;
    fetchChannel(guildId: string | G, channelId: string): Promise<C | null>;
    fetchMessage(guildId: string | G, channelId: string | C, messageId: string): Promise<M>;
}

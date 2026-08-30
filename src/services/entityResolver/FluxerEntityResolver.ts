import { Channel, Client, Guild, GuildEmoji, Message } from '@fluxerjs/core';
import NodeCache from 'node-cache';
import EntityResolver from '../entityResolver/EntityResolver';

export default class FluxerEntityResolver implements EntityResolver<
    Guild,
    Channel,
    Message,
    GuildEmoji
> {
    private fluxerClient: Client | null = null;
    private readonly emojiCache = new NodeCache({
        stdTTL: 60,
        useClones: false,
    });

    setFluxerClient(client: Client) {
        this.fluxerClient = client;
    }

    private ensureClient(): Client {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in FluxerEntityResolver');
        }
        return this.fluxerClient;
    }

    async fetchGuild(guildId: string): Promise<Guild | null> {
        const client = this.ensureClient();

        try {
            return await client.guilds.fetch(guildId);
        } catch {
            return null;
        }
    }

    async fetchChannel(
        guildOrId: string | Guild,
        channelId: string
    ): Promise<Channel | null> {
        this.ensureClient();

        try {
            const guild =
                typeof guildOrId === 'string'
                    ? await this.fetchGuild(guildOrId)
                    : guildOrId;

            if (!guild) return null;

            return (
                (await guild.fetchChannels()).find(
                    (ch) => ch.id === channelId
                ) || null
            );
        } catch {
            return null;
        }
    }

    async fetchMessage(
        guildOrId: string | Guild,
        channelOrId: string | Channel,
        messageId: string
    ): Promise<Message> {
        const channel =
            typeof channelOrId === 'string'
                ? await this.fetchChannel(guildOrId, channelOrId)
                : channelOrId;

        if (!channel) {
            throw new Error('Fluxer channel not found');
        }

        if (!channel.isTextBased()) {
            throw new Error('Fluxer channel is not text-based');
        }

        return await channel.messages.fetch(messageId);
    }

    async fetchEmojis(guildId: string | Guild): Promise<GuildEmoji[]> {
        const id = typeof guildId === 'string' ? guildId : guildId.id;

        const cached = this.emojiCache.get<GuildEmoji[]>(id);
        if (cached) return cached;

        const guild =
            typeof guildId === 'string'
                ? await this.fetchGuild(guildId)
                : guildId;

        if (!guild) {
            throw new Error('Fluxer guild not found');
        }

        const emojisColl = await guild.fetchEmojis();
        const emojis = emojisColl.map((e) => e);
        this.emojiCache.set(id, emojis);
        return emojis;
    }
}

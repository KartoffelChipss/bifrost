import { Channel, Client, Guild, GuildEmoji, Message } from 'discord.js';
import NodeCache from 'node-cache';
import EntityResolver from '../entityResolver/EntityResolver';

export default class DiscordEntityResolver implements EntityResolver<
    Guild,
    Channel,
    Message<boolean>,
    GuildEmoji
> {
    private discordClient: Client | null = null;
    private readonly emojiCache = new NodeCache({
        stdTTL: 60,
        useClones: false,
    });

    setDiscordClient(client: Client) {
        this.discordClient = client;
    }

    private ensureClient(): Client {
        if (!this.discordClient) {
            throw new Error('Discord client not set in DiscordEntityResolver');
        }
        return this.discordClient;
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

            return await guild.channels.fetch(channelId);
        } catch {
            return null;
        }
    }

    async fetchMessage(
        guildOrId: string | Guild,
        channelOrId: string | Channel,
        messageId: string
    ): Promise<Message<boolean>> {
        this.ensureClient();

        const channel =
            typeof channelOrId === 'string'
                ? await this.fetchChannel(guildOrId, channelOrId)
                : channelOrId;

        if (!channel || !channel.isTextBased()) {
            throw new Error('Discord channel not found or not text-based');
        }

        return await channel.messages.fetch(messageId);
    }

    async fetchEmojis(guildOrId: string | Guild): Promise<GuildEmoji[]> {
        this.ensureClient();

        const id = typeof guildOrId === 'string' ? guildOrId : guildOrId.id;

        const cached = this.emojiCache.get<GuildEmoji[]>(id);
        if (cached) return cached;

        const guild =
            typeof guildOrId === 'string'
                ? await this.fetchGuild(guildOrId)
                : guildOrId;

        if (!guild) {
            throw new Error('Discord guild not found');
        }

        const emojiCollection = await guild.emojis.fetch();
        const emojis = emojiCollection.map((emoji) => emoji);
        this.emojiCache.set(id, emojis);
        return emojis;
    }
}

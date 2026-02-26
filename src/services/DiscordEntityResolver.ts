import { Channel, Client, Guild, Message } from 'discord.js';
import EntityResolver from './EntityResolver';

export default class DiscordEntityResolver implements EntityResolver<
    Guild,
    Channel,
    Message<boolean>
> {
    private discordClient: Client | null = null;

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

    async fetchChannel(guildOrId: string | Guild, channelId: string): Promise<Channel | null> {
        const client = this.ensureClient();

        try {
            const guild =
                typeof guildOrId === 'string' ? await this.fetchGuild(guildOrId) : guildOrId;

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
        const client = this.ensureClient();

        const channel =
            typeof channelOrId === 'string'
                ? await this.fetchChannel(guildOrId, channelOrId)
                : channelOrId;

        if (!channel || !channel.isTextBased()) {
            throw new Error('Discord channel not found or not text-based');
        }

        return await channel.messages.fetch(messageId);
    }
}

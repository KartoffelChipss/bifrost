import { Channel, Client, Guild, Message } from '@fluxerjs/core';
import EntityResolver from './EntityResolver';

export default class FluxerEntityResolver implements EntityResolver<Guild, Channel, Message> {
    private fluxerClient: Client | null = null;

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

    async fetchChannel(guildOrId: string | Guild, channelId: string): Promise<Channel | null> {
        const client = this.ensureClient();

        try {
            const guild =
                typeof guildOrId === 'string' ? await this.fetchGuild(guildOrId) : guildOrId;

            if (!guild) return null;

            return (await guild.fetchChannels()).find((ch) => ch.id === channelId) || null;
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
}

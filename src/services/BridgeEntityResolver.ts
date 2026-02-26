import { Client as FluxerClient, TextChannel as FluxerTextChannel } from '@fluxerjs/core';
import { Client as DiscordClient } from 'discord.js';

export default class BridgeEntityResolver {
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

    public setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    public setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    public async fetchFluxerGuild(guildId: string) {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in BridgeEntityResolver');
        }

        try {
            const guild = await this.fluxerClient.guilds.fetch(guildId);
            return guild;
        } catch (error) {
            console.error('Error fetching Fluxer guild:', error);
            throw error;
        }
    }

    public async fetchDiscordGuild(guildId: string) {
        if (!this.discordClient) {
            throw new Error('Discord client not set in BridgeEntityResolver');
        }

        try {
            const guild = await this.discordClient.guilds.fetch(guildId);
            return guild;
        } catch (error) {
            console.error('Error fetching Discord guild:', error);
            throw error;
        }
    }

    public async fetchFluxerChannel(channelId: string) {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in BridgeEntityResolver');
        }

        try {
            const channel = await this.fluxerClient.channels.fetch(channelId);
            return channel;
        } catch (error) {
            console.error('Error fetching Fluxer channel:', error);
            throw error;
        }
    }

    public async fetchDiscordChannel(channelId: string) {
        if (!this.discordClient) {
            throw new Error('Discord client not set in BridgeEntityResolver');
        }

        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            return channel;
        } catch (error) {
            console.error('Error fetching Discord channel:', error);
            throw error;
        }
    }

    public async fetchFluxerMessage(channelId: string, messageId: string) {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in BridgeEntityResolver');
        }

        try {
            const channel = (await this.fetchFluxerChannel(channelId)) as FluxerTextChannel;
            if (!channel) {
                throw new Error('Fluxer channel not found');
            }

            const message = await channel.messages.fetch(messageId);
            return message;
        } catch (error) {
            console.error('Error fetching Fluxer message:', error);
            throw error;
        }
    }
}

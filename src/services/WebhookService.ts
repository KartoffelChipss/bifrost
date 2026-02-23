import {
    Client as FluxerClient,
    TextChannel as FluxerTextChannel,
    Webhook as FluxerWebhook,
} from '@fluxerjs/core';
import {
    Client as DiscordClient,
    TextChannel as DiscordTextChannel,
    WebhookClient,
} from 'discord.js';
import logger from '../utils/logging/logger';
import { LinkService } from './LinkService';

type DiscordWebhook = WebhookClient;

export class WebhookService {
    private readonly linkService: LinkService;
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

    constructor(linkService: LinkService) {
        this.linkService = linkService;
    }

    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    async createDiscordWebhook(
        channelId: string,
        name: string
    ): Promise<{ id: string; token: string }> {
        if (!this.discordClient) {
            throw new Error('Discord client not set in WebhookService');
        }

        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            if (!channel || !(channel instanceof DiscordTextChannel)) {
                throw new Error('Invalid Discord channel');
            }

            console.log('Channel:', channel);

            const webhook = await channel.createWebhook({ name });
            return { id: webhook.id, token: webhook.token! };
        } catch (error: any) {
            logger.error('Error creating Discord webhook:', error);
            throw error;
        }
    }

    async getDiscordWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<DiscordWebhook | null> {
        if (!this.discordClient) {
            throw new Error('Discord client not set in WebhookService');
        }

        try {
            const webhook = await this.discordClient.fetchWebhook(webhookId, webhookToken);
            if (!webhook) return null;
            const webhookClient = new WebhookClient({ id: webhookId, token: webhookToken });
            return webhookClient;
        } catch (error: any) {
            logger.error('Error getting or creating Discord webhook:', error);
            throw error;
        }
    }

    async sendMessageViaDiscordWebhook(
        webhook: DiscordWebhook,
        data: { content: string; username: string; avatarURL: string }
    ) {
        try {
            await webhook.send({
                content: data.content,
                username: data.username,
                avatarURL: data.avatarURL,
            });
        } catch (error: any) {
            logger.error('Error sending message via Discord webhook:', error);
            throw error;
        }
    }

    async createFluxerWebhook(
        channelId: string,
        name: string
    ): Promise<{ id: string; token: string }> {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in WebhookService');
        }

        try {
            const channel = (await this.fluxerClient.channels.fetch(
                channelId
            )) as FluxerTextChannel;
            const webhook = await channel.createWebhook({ name });
            return { id: webhook.id, token: webhook.token! };
        } catch (error: any) {
            logger.error('Error creating Fluxer webhook:', error);
            throw error;
        }
    }

    async getFluxerWebhook(webhookId: string, webhookToken: string): Promise<FluxerWebhook> {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in WebhookService');
        }

        try {
            const webhook = FluxerWebhook.fromToken(this.fluxerClient, webhookId, webhookToken);
            return webhook;
        } catch (error: any) {
            logger.error('Error getting or creating Fluxer webhook:', error);
            throw error;
        }
    }

    async sendMessageViaFluxerWebhook(
        webhook: FluxerWebhook,
        data: { content: string; username: string; avatarURL: string }
    ) {
        try {
            await webhook.send({
                content: data.content,
                username: data.username,
                avatar_url: data.avatarURL,
            });
        } catch (error: any) {
            logger.error('Error sending message via Fluxer webhook:', error);
            throw error;
        }
    }
}

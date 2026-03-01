import {
    Client as FluxerClient,
    TextChannel as FluxerTextChannel,
    Webhook as FluxerWebhook,
    MessageAttachmentFlags,
} from '@fluxerjs/core';
import {
    AttachmentBuilder,
    Client as DiscordClient,
    TextChannel as DiscordTextChannel,
    WebhookClient,
} from 'discord.js';
import logger from '../utils/logging/logger';
import { LinkService } from './LinkService';
import WebhookEmbed from './WebhookEmbed';

type DiscordWebhook = WebhookClient;

export type WebhookAttachment = {
    url: string;
    name: string;
    spoiler?: boolean;
};

export type WebhookMessageData = {
    content: string;
    username: string;
    avatarURL: string;
    attachments?: WebhookAttachment[];
    embeds?: WebhookEmbed[];
};

export class WebhookService {
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

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
        data: WebhookMessageData
    ): Promise<{ messageId: string }> {
        try {
            const files = data.attachments?.map((att) => {
                const attBuilder = new AttachmentBuilder(att.url, { name: att.name });
                if (att.spoiler) attBuilder.setSpoiler(true);
                return attBuilder;
            });

            const { id } = await webhook.send({
                content: data.content,
                username: data.username,
                avatarURL: data.avatarURL,
                files,
                embeds: data.embeds?.map((embed) => embed.toDiscordEmbed()) || [],
            });

            return { messageId: id };
        } catch (error: any) {
            logger.error('Error sending message via Discord webhook:', error);
            throw error;
        }
    }

    async editMessageViaDiscordWebhook(
        webhook: DiscordWebhook,
        messageId: string,
        data: WebhookMessageData
    ): Promise<void> {
        try {
            const files = data.attachments?.map((att) => {
                const attBuilder = new AttachmentBuilder(att.url, { name: att.name });
                if (att.spoiler) attBuilder.setSpoiler(true);
                return attBuilder;
            });

            await webhook.editMessage(messageId, {
                content: data.content,
                files,
                embeds: data.embeds?.map((embed) => embed.toDiscordEmbed()) || [],
            });
        } catch (error: any) {
            logger.error('Error editing message via Discord webhook:', error);
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
        data: WebhookMessageData
    ): Promise<{ messageId: string }> {
        try {
            const msg = await webhook.send(
                {
                    content: data.content,
                    username: data.username,
                    avatar_url: data.avatarURL,
                    files:
                        data.attachments?.map((attachment) => ({
                            url: attachment.url,
                            name: attachment.name,
                            filename: attachment.name,
                        })) || [],
                    attachments:
                        data.attachments?.map((attachment, index) => ({
                            id: index,
                            name: attachment.name,
                            filename: attachment.name,
                            flags: attachment.spoiler
                                ? MessageAttachmentFlags.IS_SPOILER
                                : undefined,
                        })) || [],
                    embeds: data.embeds?.map((embed) => embed.toFluxerEmbed()) || [],
                },
                true
            );

            if (!msg) {
                throw new Error('Did not receive message object after sending via Fluxer webhook');
            }

            return { messageId: msg.id };
        } catch (error: any) {
            logger.error('Error sending message via Fluxer webhook:', error);
            throw error;
        }
    }
}

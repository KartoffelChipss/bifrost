import {
    Client as FluxerClient,
    TextChannel as FluxerTextChannel,
    Webhook as FluxerWebhook,
    MessageAttachmentFlags,
} from '@fluxerjs/core';
import {
    AttachmentBuilder,
    Client as DiscordClient,
    WebhookClient,
} from 'discord.js';
import logger from '../utils/logging/logger';
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
            const isValidWebhookChannel =
                channel &&
                channel.isTextBased() &&
                !channel.isDMBased() &&
                !channel.isThread();
            if (!isValidWebhookChannel) {
                throw new Error('Invalid Discord channel');
            }

            const webhook = await channel.createWebhook({ name });
            return { id: webhook.id, token: webhook.token! };
        } catch (error: unknown) {
            logger.error(
                'Failed creating Discord webhook',
                { operation: 'createDiscordWebhook', channelId, name },
                error
            );
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
            const webhook = await this.discordClient.fetchWebhook(
                webhookId,
                webhookToken
            );
            if (!webhook) return null;
            const webhookClient = new WebhookClient({
                id: webhookId,
                token: webhookToken,
            });
            return webhookClient;
        } catch (error: unknown) {
            logger.error(
                'Failed fetching Discord webhook',
                { operation: 'getDiscordWebhook', webhookId },
                error
            );
            throw error;
        }
    }

    async sendMessageViaDiscordWebhook(
        webhook: DiscordWebhook,
        data: WebhookMessageData
    ): Promise<{ messageId: string }> {
        try {
            const files = data.attachments?.map((att) => {
                const attBuilder = new AttachmentBuilder(att.url, {
                    name: att.name,
                });
                if (att.spoiler) attBuilder.setSpoiler(true);
                return attBuilder;
            });

            const { id } = await webhook.send({
                content: data.content,
                username: data.username,
                avatarURL: data.avatarURL,
                files,
                embeds:
                    data.embeds?.map((embed) => embed.toDiscordEmbed()) || [],
            });

            return { messageId: id };
        } catch (error: unknown) {
            logger.error(
                'Failed sending message via Discord webhook',
                {
                    operation: 'sendMessageViaDiscordWebhook',
                    hasContent: Boolean(data.content),
                    attachmentCount: data.attachments?.length || 0,
                    embedCount: data.embeds?.length || 0,
                },
                error
            );
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
                const attBuilder = new AttachmentBuilder(att.url, {
                    name: att.name,
                });
                if (att.spoiler) attBuilder.setSpoiler(true);
                return attBuilder;
            });

            await webhook.editMessage(messageId, {
                content: data.content,
                files,
                embeds:
                    data.embeds?.map((embed) => embed.toDiscordEmbed()) || [],
            });
        } catch (error: unknown) {
            logger.error(
                'Failed editing message via Discord webhook',
                {
                    operation: 'editMessageViaDiscordWebhook',
                    messageId,
                    hasContent: Boolean(data.content),
                    attachmentCount: data.attachments?.length || 0,
                    embedCount: data.embeds?.length || 0,
                },
                error
            );
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
        } catch (error: unknown) {
            logger.error(
                'Failed creating Fluxer webhook',
                { operation: 'createFluxerWebhook', channelId, name },
                error
            );
            throw error;
        }
    }

    async getFluxerWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<FluxerWebhook> {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in WebhookService');
        }

        try {
            const webhook = FluxerWebhook.fromToken(
                this.fluxerClient,
                webhookId,
                webhookToken
            );
            return webhook;
        } catch (error: unknown) {
            logger.error(
                'Failed creating Fluxer webhook instance from token',
                { operation: 'getFluxerWebhook', webhookId },
                error
            );
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
                    embeds:
                        data.embeds?.map((embed) => embed.toFluxerEmbed()) ||
                        [],
                },
                true
            );

            if (!msg) {
                throw new Error(
                    'Did not receive message object after sending via Fluxer webhook'
                );
            }

            return { messageId: msg.id };
        } catch (error: unknown) {
            logger.error(
                'Failed sending message via Fluxer webhook',
                {
                    operation: 'sendMessageViaFluxerWebhook',
                    hasContent: Boolean(data.content),
                    attachmentCount: data.attachments?.length || 0,
                    embedCount: data.embeds?.length || 0,
                },
                error
            );
            throw error;
        }
    }
}

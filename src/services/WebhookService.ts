import {
    Client as FluxerClient,
    TextChannel as FluxerTextChannel,
    Webhook as FluxerWebhook,
    MessageAttachmentFlags,
    Routes as FluxerRoutes,
} from '@fluxerjs/core';
import {
    AttachmentBuilder,
    Client as DiscordClient,
    WebhookClient,
} from 'discord.js';
import logger from '../utils/logging/logger';
import WebhookEmbed from './WebhookEmbed';
// Fork: pings, native replies and stickers (src/relay-extras/fidelity).
import {
    discordSendFields,
    fluxerEditFields,
    fluxerSendFields,
} from '../relay-extras/fidelity/send';
import {
    editNeedsCopy,
    editPayload,
    MAX_FALLBACKS,
    rejectedField,
    repliesNatively,
    withoutField,
} from '../relay-extras/fidelity/fallback';
import type { CopyFidelity } from '../relay-extras/fidelity/types';

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
    fidelity?: CopyFidelity; // Fork
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
            // Fork: announcement and voice channels take webhooks too, so
            // they can be linked. Threads and DMs cannot.
            if (
                !channel?.isTextBased() ||
                channel.isDMBased() ||
                channel.isThread()
            ) {
                throw new Error('Invalid Discord channel');
            }

            const webhook = await channel.createWebhook({ name });
            return { id: webhook.id, token: webhook.token! };
        } catch (error: unknown) {
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
                ...discordSendFields(data.fidelity), // Fork
            });

            return { messageId: id };
        } catch (error: unknown) {
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
                ...discordSendFields(data.fidelity), // Fork
            });
        } catch (error: unknown) {
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
        } catch (error: unknown) {
            logger.error('Error creating Fluxer webhook:', error);
            throw error;
        }
    }

    async deleteDiscordWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<void> {
        if (!this.discordClient) return;
        try {
            const webhook = await this.discordClient.fetchWebhook(
                webhookId,
                webhookToken
            );
            await webhook.delete();
        } catch (error) {
            logger.error('Error deleting Discord webhook:', error);
            throw error;
        }
    }

    async deleteFluxerWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<void> {
        if (!this.fluxerClient) return;
        try {
            const webhook = FluxerWebhook.fromToken(
                this.fluxerClient,
                webhookId,
                webhookToken
            );
            await webhook.delete();
        } catch (error) {
            logger.error('Error deleting Fluxer webhook:', error);
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
            logger.error('Error getting or creating Fluxer webhook:', error);
            throw error;
        }
    }

    async sendMessageViaFluxerWebhook(
        webhook: FluxerWebhook,
        data: WebhookMessageData
    ): Promise<{ messageId: string }> {
        // Fork: retries without a native reply or sticker Fluxer rejected.
        const sent = await this.sendCopyViaFluxerWebhook(webhook, data);
        if (!sent.ok) throw sent.error;
        return { messageId: sent.messageId };
    }

    /**
     * Fork: sends a copy, and on a rejection of its native reply or
     * stickers sends it again with upstream's quote or sticker images
     * (src/relay-extras/fidelity/fallback.ts). `payload` is the last
     * payload tried, so a failed send is queued without a rejected field.
     */
    async sendCopyViaFluxerWebhook(
        webhook: FluxerWebhook,
        data: WebhookMessageData
    ): Promise<FluxerCopyResult> {
        let payload = data;
        for (let attempt = 0; attempt <= MAX_FALLBACKS; attempt++) {
            try {
                const messageId = await this.postFluxerCopy(webhook, payload);
                return { ok: true, messageId, payload };
            } catch (error: unknown) {
                const field = rejectedField(error, payload.fidelity);
                if (!field) {
                    logger.error(
                        'Error sending message via Fluxer webhook:',
                        error
                    );
                    return { ok: false, error, payload };
                }
                logger.warn(
                    `Fluxer rejected the copy's ${field}, sending it without: ${String(error)}`
                );
                payload = withoutField(payload, field);
            }
        }
        // Unreachable: each fallback drops one of MAX_FALLBACKS fields.
        const error = new Error('Fluxer send fallbacks exhausted');
        return { ok: false, error, payload };
    }

    private async postFluxerCopy(
        webhook: FluxerWebhook,
        data: WebhookMessageData
    ): Promise<string> {
        const msg = await webhook.send(
            {
                content: data.content,
                username: data.username,
                avatarUrl: data.avatarURL,
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
                    data.embeds?.map((embed) => embed.toFluxerEmbed()) || [],
                ...fluxerSendFields(data.fidelity), // Fork
            },
            true
        );

        if (!msg) {
            throw new Error(
                'Did not receive message object after sending via Fluxer webhook'
            );
        }

        return msg.id;
    }

    async editMessageViaFluxerWebhook(
        webhook: FluxerWebhook,
        messageId: string,
        payload: WebhookMessageData
    ): Promise<void> {
        try {
            const route =
                FluxerRoutes.webhookExecute(webhook.id, webhook.token!) +
                `/messages/${messageId}`;
            // Fork: keeps the quote or sticker images the copy was sent with.
            const data = await this.fluxerEditData(webhook, route, payload);
            await webhook.client.rest.patch(route, {
                body: {
                    content: data.content,
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
                    ...fluxerEditFields(data.fidelity), // Fork
                },
                auth: false,
            });
        } catch (error: unknown) {
            logger.error('Error editing message via Fluxer webhook:', error);
            throw error;
        }
    }

    /**
     * Fork: an edit cannot add or drop a native reply, so a payload that
     * replies natively asks the copy whether it does. When that fails the
     * quote stays: a quote too many beats a reply without context.
     */
    private async fluxerEditData(
        webhook: FluxerWebhook,
        route: string,
        payload: WebhookMessageData
    ): Promise<WebhookMessageData> {
        if (!editNeedsCopy(payload)) return editPayload(payload, false);
        try {
            const copy: unknown = await webhook.client.rest.get(route, {
                auth: false,
            });
            return editPayload(payload, repliesNatively(copy));
        } catch (error: unknown) {
            logger.warn(
                `Could not read the Fluxer copy before an edit, keeping the reply quote: ${String(error)}`
            );
            return editPayload(payload, false);
        }
    }
}

/** Fork: a Fluxer send and the payload last tried (sendCopyViaFluxerWebhook). */
export type FluxerCopyResult =
    | {
          readonly ok: true;
          readonly messageId: string;
          readonly payload: WebhookMessageData;
      }
    | {
          readonly ok: false;
          readonly error: unknown;
          readonly payload: WebhookMessageData;
      };

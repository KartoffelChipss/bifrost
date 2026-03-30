import { Op } from 'sequelize';
import { QueuedMessageModel } from '../db/models/QueuedMessageModel';
import WebhookEmbed from './WebhookEmbed';
import { LinkService } from './LinkService';
import { WebhookAttachment, WebhookMessageData, WebhookService } from './WebhookService';
import logger from '../utils/logging/logger';

export type SerializableEmbed = ReturnType<WebhookEmbed['toPlainObject']>;

export type SerializableWebhookMessageData = {
    content: string;
    username: string;
    avatarURL: string;
    attachments?: WebhookAttachment[];
    embeds?: SerializableEmbed[];
};

export function toSerializable(data: WebhookMessageData): SerializableWebhookMessageData {
    return {
        ...data,
        embeds: data.embeds?.map((e) => e.toPlainObject()),
    };
}

function toWebhookMessageData(data: SerializableWebhookMessageData): WebhookMessageData {
    return {
        ...data,
        embeds: data.embeds?.map((e) => WebhookEmbed.fromPlainObject(e)),
    };
}

export default class MessageQueueService {
    private drainInterval: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly ttlMs: number) {}

    async enqueue(
        direction: 'discord_to_fluxer' | 'fluxer_to_discord',
        channelLinkId: string,
        sourceMessageId: string,
        payload: SerializableWebhookMessageData
    ): Promise<void> {
        await QueuedMessageModel.create({
            direction,
            channelLinkId,
            sourceMessageId,
            payload: JSON.stringify(payload),
        });
        logger.debug(`Queued message for retry: direction=${direction} sourceMessageId=${sourceMessageId}`);
    }

    async drain(webhookService: WebhookService, linkService: LinkService): Promise<void> {
        const expiryCutoff = new Date(Date.now() - this.ttlMs);

        const expired = await QueuedMessageModel.destroy({
            where: { createdAt: { [Op.lt]: expiryCutoff } },
        });
        if (expired > 0) {
            logger.info(`Message queue: discarded ${expired} expired entr${expired === 1 ? 'y' : 'ies'} (TTL exceeded)`);
        }

        const pending = await QueuedMessageModel.findAll();
        if (pending.length === 0) return;

        logger.info(`Message queue: attempting to drain ${pending.length} pending entr${pending.length === 1 ? 'y' : 'ies'}`);

        for (const entry of pending) {
            try {
                const payload = toWebhookMessageData(
                    JSON.parse(entry.payload) as SerializableWebhookMessageData
                );
                const channelLink = await linkService.getChannelLinkById(entry.channelLinkId);
                if (!channelLink) {
                    logger.warn(`Queue drain: channel link ${entry.channelLinkId} no longer exists, discarding entry`);
                    await entry.destroy();
                    continue;
                }

                if (entry.direction === 'discord_to_fluxer') {
                    const webhook = await webhookService.getFluxerWebhook(
                        channelLink.fluxerWebhookId,
                        channelLink.fluxerWebhookToken
                    );
                    const { messageId: fluxerMessageId } =
                        await webhookService.sendMessageViaFluxerWebhook(webhook, payload);
                    await linkService.createMessageLink({
                        discordMessageId: entry.sourceMessageId,
                        fluxerMessageId,
                        guildLinkId: channelLink.guildLinkId,
                        channelLinkId: channelLink.id,
                    });
                } else {
                    const webhook = await webhookService.getDiscordWebhook(
                        channelLink.discordWebhookId,
                        channelLink.discordWebhookToken
                    );
                    if (!webhook) {
                        throw new Error(`Discord webhook not found for channel link ${channelLink.id}`);
                    }
                    const { messageId: discordMessageId } =
                        await webhookService.sendMessageViaDiscordWebhook(webhook, payload);
                    await linkService.createMessageLink({
                        discordMessageId,
                        fluxerMessageId: entry.sourceMessageId,
                        guildLinkId: channelLink.guildLinkId,
                        channelLinkId: channelLink.id,
                    });
                }

                await entry.destroy();
                logger.info(`Queue drain: relayed queued message ${entry.id} (${entry.direction})`);
            } catch (err) {
                await entry.update({
                    retryCount: entry.retryCount + 1,
                    lastError: String(err),
                });
                logger.warn(`Queue drain: retry failed for entry ${entry.id} (attempt ${entry.retryCount + 1}): ${err}`);
            }
        }
    }

    startDrainInterval(
        webhookService: WebhookService,
        linkService: LinkService,
        intervalMs = 30_000
    ): void {
        this.drainInterval = setInterval(() => {
            this.drain(webhookService, linkService).catch((err) =>
                logger.error('Queue drain interval error:', err)
            );
        }, intervalMs);
    }

    stopDrainInterval(): void {
        if (this.drainInterval) {
            clearInterval(this.drainInterval);
            this.drainInterval = null;
        }
    }
}

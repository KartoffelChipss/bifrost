import { Message } from '@fluxerjs/core';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import MessageQueueService, { toSerializable } from '../MessageQueueService';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import MetricsService from '../MetricsService';
import { GeneralEmoji } from '../../utils/emojis';

const MAX_MENTION_CONTENT = 2000;

export default class FluxerToDiscordMessageRelay extends MessageRelay<Message> {
    private readonly discordEntityResolver: DiscordEntityResolver;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        discordEntityResolver,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<Message, WebhookMessageData>;
        metricsService?: MetricsService;
        queueService?: MessageQueueService;
        discordEntityResolver: DiscordEntityResolver;
    }) {
        super({
            linkService,
            webhookService,
            messageTransformer,
            metricsService,
            queueService,
        });
        this.discordEntityResolver = discordEntityResolver;
    }

    public async relayMessage(message: Message): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        const linkedChannel = await linkService.getChannelLinkByFluxerChannelId(
            message.channelId
        );
        if (!linkedChannel) {
            logger.warn(
                `Fluxer message ${message.id} not relayed to Discord: no channel link for Fluxer channel ${message.channelId}`
            );
            return;
        }
        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) {
            logger.warn(
                `Fluxer message ${message.id} not relayed to Discord: no guild link for channel link ${linkedChannel.linkId}`
            );
            return;
        }

        let msg: WebhookMessageData;
        if (message.type === 7) {
            msg = {
                content: formatJoinMessage(
                    message.author.username +
                        '#' +
                        message.author.discriminator,
                    'fluxer'
                ),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        } else {
            let discordEmojis: GeneralEmoji[] = [];
            try {
                discordEmojis = await this.discordEntityResolver.fetchEmojis(
                    guildLink.discordGuildId
                );
            } catch (error) {
                logger.warn(
                    'Failed to fetch Discord emojis, relaying without emoji replacement:',
                    error
                );
            }

            try {
                msg = await this.getMessageTransformer().transformMessage(
                    message,
                    discordEmojis
                );
            } catch (error) {
                logger.error(
                    'Failed to transform Fluxer message, relaying raw content:',
                    error
                );
                msg = {
                    content: message.content,
                    username: message.author.username,
                    avatarURL: message.author.avatarURL() || '',
                };
            }

            const referencedMessageId =
                message.referencedMessage?.id ??
                message.messageReference?.message_id;

            if (referencedMessageId) {
                try {
                    msg = await this.addReplyMention(
                        msg,
                        referencedMessageId
                    );
                } catch (error) {
                    logger.error(
                        'Failed to resolve reply mention, relaying without mention:',
                        error
                    );
                }
            } else if (message.messageReference) {
                logger.debug(
                    'Reply detected on Fluxer but no referenced message id could be resolved (referencedMessage and messageReference.message_id are both missing)'
                );
            }
        }

        try {
            const webhook = await webhookService.getDiscordWebhook(
                linkedChannel.discordWebhookId,
                linkedChannel.discordWebhookToken
            );
            if (!webhook) {
                logger.warn(
                    `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message`
                );
                return;
            }

            const { messageId: webhookMessageId } =
                await webhookService.sendMessageViaDiscordWebhook(webhook, msg);

            if (message.type !== 7) {
                await linkService.createMessageLink({
                    discordMessageId: webhookMessageId,
                    fluxerMessageId: message.id,
                    guildLinkId: linkedChannel.guildLinkId,
                    channelLinkId: linkedChannel.id,
                    fluxerAuthorId: message.author.id,
                    fluxerAuthorUsername: message.author.username,
                });
            }
            this.metricsService?.messagesRelayed.inc({
                direction: 'fluxer_to_discord',
            });
        } catch (error) {
            logger.error('Error relaying message to Discord:', error);
            this.metricsService?.messageRelayErrors.inc({
                direction: 'fluxer_to_discord',
            });
            const serializable = toSerializable(msg);
            serializable.authorMeta = {
                fluxerAuthorId: message.author.id,
                fluxerAuthorUsername: message.author.username,
            };
            await this.queueService?.enqueue(
                'fluxer_to_discord',
                linkedChannel.id,
                message.id,
                serializable
            );
        }
    }

    public async addReplyMention(
        msg: WebhookMessageData,
        referencedFluxerMessageId: string | null | undefined
    ): Promise<WebhookMessageData> {
        if (!referencedFluxerMessageId) return msg;

        const linkService = this.getLinkService();
        const messageLink =
            await linkService.getMessageLinkByFluxerMessageId(
                referencedFluxerMessageId
            );
        if (!messageLink) {
            logger.warn(
                `Reply mention skipped: no message link for referenced Fluxer message ${referencedFluxerMessageId}`
            );
            return msg;
        }
        if (!messageLink.discordAuthorId) {
            logger.debug(
                `Reply mention skipped: message link ${messageLink.id} has no discordAuthorId (referenced message did not originate from Discord)`
            );
            return msg;
        }

        const mention = `<@${messageLink.discordAuthorId}>`;
        if (msg.content.includes(mention)) return msg;

        if (msg.content.length + mention.length + 1 > MAX_MENTION_CONTENT) {
            logger.warn(
                `Dropping reply mention: content length ${msg.content.length} + mention ${mention.length} exceeds ${MAX_MENTION_CONTENT}`
            );
            return msg;
        }

        return {
            ...msg,
            content: `${mention} ${msg.content}`,
        };
    }
}

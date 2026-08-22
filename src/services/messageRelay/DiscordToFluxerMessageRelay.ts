import {
    Message,
    MessageFlags,
    MessageType,
    OmitPartialGroupDMChannel,
} from 'discord.js';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import MessageQueueService, { toSerializable } from '../MessageQueueService';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import MetricsService from '../MetricsService';
import { GeneralEmoji } from '../../utils/emojis';

const MAX_MENTION_CONTENT = 2000;

export default class DiscordToFluxerMessageRelay extends MessageRelay<
    OmitPartialGroupDMChannel<Message<boolean>>
> {
    private readonly fluxerEntityResolver: FluxerEntityResolver;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        fluxerEntityResolver,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<
            OmitPartialGroupDMChannel<Message<boolean>>,
            WebhookMessageData
        >;
        metricsService?: MetricsService;
        queueService?: MessageQueueService;
        fluxerEntityResolver: FluxerEntityResolver;
    }) {
        super({
            linkService,
            webhookService,
            messageTransformer,
            metricsService,
            queueService,
        });
        this.fluxerEntityResolver = fluxerEntityResolver;
    }

    public async relayMessage(
        message: OmitPartialGroupDMChannel<Message<boolean>>
    ): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        const linkedChannel =
            await linkService.getChannelLinkByDiscordChannelId(
                message.channelId
            );
        if (!linkedChannel) {
            logger.warn(
                `Discord message ${message.id} not relayed to Fluxer: no channel link for Discord channel ${message.channelId}`
            );
            return;
        }
        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) {
            logger.warn(
                `Discord message ${message.id} not relayed to Fluxer: no guild link for channel link ${linkedChannel.linkId}`
            );
            return;
        }

        let msg: WebhookMessageData;
        if (message.type === MessageType.UserJoin) {
            msg = {
                content: formatJoinMessage(message.author.username, 'discord'),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        } else {
            let fluxerEmojis: GeneralEmoji[] = [];
            try {
                fluxerEmojis = await this.fluxerEntityResolver.fetchEmojis(
                    guildLink.fluxerGuildId
                );
            } catch (error) {
                logger.warn(
                    'Failed to fetch Fluxer emojis, relaying without emoji replacement:',
                    error
                );
            }

            try {
                msg = await this.getMessageTransformer().transformMessage(
                    message,
                    fluxerEmojis
                );
            } catch (error) {
                logger.error(
                    'Failed to transform Discord message, relaying raw content:',
                    error
                );
                msg = {
                    content: message.content,
                    username: message.author.username,
                    avatarURL: message.author.avatarURL() || '',
                };
            }

            if (
                message.reference &&
                !message.flags.has(MessageFlags.HasSnapshot)
            ) {
                try {
                    msg = await this.addReplyMention(
                        msg,
                        message.reference.messageId
                    );
                } catch (error) {
                    logger.error(
                        'Failed to resolve reply mention, relaying without mention:',
                        error
                    );
                }
            }
        }

        try {
            const webhook = await webhookService.getFluxerWebhook(
                linkedChannel.fluxerWebhookId,
                linkedChannel.fluxerWebhookToken
            );

            const { messageId: webhookMessageId } =
                await webhookService.sendMessageViaFluxerWebhook(webhook, msg);

            if (message.type !== MessageType.UserJoin) {
                await linkService.createMessageLink({
                    discordMessageId: message.id,
                    fluxerMessageId: webhookMessageId,
                    guildLinkId: linkedChannel.guildLinkId,
                    channelLinkId: linkedChannel.id,
                    discordAuthorId: message.author.id,
                    discordAuthorUsername: message.author.username,
                });
            }
            this.metricsService?.messagesRelayed.inc({
                direction: 'discord_to_fluxer',
            });
        } catch (error) {
            logger.error('Error relaying message to Fluxer:', error);
            this.metricsService?.messageRelayErrors.inc({
                direction: 'discord_to_fluxer',
            });
            const serializable = toSerializable(msg);
            serializable.authorMeta = {
                discordAuthorId: message.author.id,
                discordAuthorUsername: message.author.username,
            };
            await this.queueService?.enqueue(
                'discord_to_fluxer',
                linkedChannel.id,
                message.id,
                serializable
            );
        }
    }

    public async addReplyMention(
        msg: WebhookMessageData,
        referencedMessageId: string | undefined | null
    ): Promise<WebhookMessageData> {
        if (!referencedMessageId) return msg;

        const linkService = this.getLinkService();
        const messageLink =
            await linkService.getMessageLinkByDiscordMessageId(
                referencedMessageId
            );
        if (!messageLink) {
            logger.warn(
                `Reply mention skipped: no message link for referenced Discord message ${referencedMessageId}`
            );
            return msg;
        }
        if (!messageLink.fluxerAuthorId) {
            logger.debug(
                `Reply mention skipped: message link ${messageLink.id} has no fluxerAuthorId (referenced message did not originate from Fluxer)`
            );
            return msg;
        }

        const mention = `<@${messageLink.fluxerAuthorId}>`;
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

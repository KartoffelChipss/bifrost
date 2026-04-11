import { Message, MessageType, OmitPartialGroupDMChannel } from 'discord.js';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import MessageQueueService, { toSerializable } from '../MessageQueueService';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import MetricsService from '../MetricsService';

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
        if (!linkedChannel) return;
        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        // Build payload before attempting send so it can be queued on failure
        let msg: WebhookMessageData;
        if (message.type === MessageType.UserJoin) {
            msg = {
                content: formatJoinMessage(message.author.username, 'discord'),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        } else {
            const fluxerEmojis = await this.fluxerEntityResolver.fetchEmojis(
                guildLink.fluxerGuildId
            );
            msg = await this.getMessageTransformer().transformMessage(
                message,
                fluxerEmojis
            );
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
            await this.queueService?.enqueue(
                'discord_to_fluxer',
                linkedChannel.id,
                message.id,
                toSerializable(msg)
            );
        }
    }
}

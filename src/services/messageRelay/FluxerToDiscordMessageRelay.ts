import { AccountLinkService } from '../AccountLinkService';
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

export default class FluxerToDiscordMessageRelay extends MessageRelay<Message> {
    private readonly accountLinkService: AccountLinkService;
    private readonly discordEntityResolver: DiscordEntityResolver;

    constructor({
        accountLinkService,
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        discordEntityResolver,
    }: {
        accountLinkService: AccountLinkService;
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
        this.accountLinkService = accountLinkService;
        this.discordEntityResolver = discordEntityResolver;
    }

    public async relayMessage(message: Message): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        const linkedChannel = await linkService.getChannelLinkByFluxerChannelId(
            message.channelId
        );
        if (!linkedChannel) return;
        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        // Build payload before attempting send so it can be queued on failure
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
            const discordEmojis = await this.discordEntityResolver.fetchEmojis(
                guildLink.discordGuildId
            );
            msg = await this.getMessageTransformer().transformMessage(
                message,
                discordEmojis
            );
            const counterpart = guildLink.discordAccountPresentationEnabled
                ? await this.accountLinkService.counterpart(
                      'fluxer',
                      message.author.id
                  )
                : null;
            if (counterpart) {
                const identity =
                    await this.discordEntityResolver.fetchAccountIdentity(
                        guildLink.discordGuildId,
                        counterpart
                    );
                if (identity) {
                    msg.username = identity.username;
                    msg.avatarURL = identity.avatarURL;
                }
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
            await this.queueService?.enqueue(
                'fluxer_to_discord',
                linkedChannel.id,
                message.id,
                toSerializable(msg)
            );
        }
    }
}

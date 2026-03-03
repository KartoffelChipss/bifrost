import { Message } from '@fluxerjs/core';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import { LinkService } from '../LinkService';

export default class FluxerToDiscordMessageRelay extends MessageRelay<Message> {
    private readonly discordEntityResolver: DiscordEntityResolver;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        discordEntityResolver,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<Message, WebhookMessageData>;
        discordEntityResolver: DiscordEntityResolver;
    }) {
        super({
            linkService,
            webhookService,
            messageTransformer,
        });
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
                    message.author.username + '#' + message.author.discriminator,
                    'fluxer'
                ),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        } else {
            msg = await this.getMessageTransformer().transformMessage(message);
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

            if (message.type === 7) {
                await webhookService.sendMessageViaDiscordWebhook(webhook, {
                    content: formatJoinMessage(
                        message.author.username +
                            '#' +
                            message.author.discriminator,
                        'fluxer'
                    ),
                    username: message.client.user?.username || 'Bifröst',
                    avatarURL: message.client.user?.avatarURL() || '',
                });
                this.metricsService?.messagesRelayed.inc({ direction: 'fluxer_to_discord' });
                return;
            }

            const discordEmojis = await this.discordEntityResolver.fetchEmojis(
                guildLink.discordGuildId
            );

            const msg = await this.getMessageTransformer().transformMessage(
                message,
                discordEmojis
            );

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
            this.metricsService?.messagesRelayed.inc({ direction: 'fluxer_to_discord' });
        } catch (error) {
            logger.error(
                'Failed relaying Fluxer message to Discord',
                {
                    source: 'FluxerToDiscordMessageRelay',
                    fluxerMessageId: message.id,
                    fluxerGuildId: message.guildId,
                    fluxerChannelId: message.channelId,
                    linkId: linkedChannel.linkId,
                    channelLinkId: linkedChannel.id,
                    guildLinkId: linkedChannel.guildLinkId,
                },
                error
            );
        }
    }
}

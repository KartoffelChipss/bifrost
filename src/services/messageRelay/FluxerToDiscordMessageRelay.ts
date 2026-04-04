import { Message } from '@fluxerjs/core';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import { toSerializable } from '../MessageQueueService';
import { WebhookMessageData } from '../WebhookService';

export default class FluxerToDiscordMessageRelay extends MessageRelay<Message> {
    public async relayMessage(message: Message): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        const linkedChannel = await linkService.getChannelLinkByFluxerChannelId(
            message.channelId
        );
        if (!linkedChannel) return;

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

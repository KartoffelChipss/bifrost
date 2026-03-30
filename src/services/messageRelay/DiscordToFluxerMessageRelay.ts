import { Message, MessageType, OmitPartialGroupDMChannel } from 'discord.js';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import { toSerializable } from '../MessageQueueService';
import { WebhookMessageData } from '../WebhookService';

export default class DiscordToFluxerMessageRelay extends MessageRelay<
    OmitPartialGroupDMChannel<Message<boolean>>
> {
    public async relayMessage(message: OmitPartialGroupDMChannel<Message<boolean>>): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        const linkedChannel = await linkService.getChannelLinkByDiscordChannelId(message.channelId);
        if (!linkedChannel) return;

        // Build payload before attempting send so it can be queued on failure
        let msg: WebhookMessageData;
        if (message.type === MessageType.UserJoin) {
            msg = {
                content: formatJoinMessage(message.author.username, 'discord'),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        } else {
            msg = await this.getMessageTransformer().transformMessage(message);
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
            this.metricsService?.messagesRelayed.inc({ direction: 'discord_to_fluxer' });
        } catch (error) {
            logger.error('Error relaying message to Fluxer:', error);
            this.metricsService?.messageRelayErrors.inc({ direction: 'discord_to_fluxer' });
            await this.queueService?.enqueue(
                'discord_to_fluxer',
                linkedChannel.id,
                message.id,
                toSerializable(msg)
            );
        }
    }
}

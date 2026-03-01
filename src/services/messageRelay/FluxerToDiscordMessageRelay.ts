import { Message } from '@fluxerjs/core';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';

export default class FluxerToDiscordMessageRelay extends MessageRelay<Message> {
    public async relayMessage(message: Message): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        const linkedChannel = await linkService.getChannelLinkByFluxerChannelId(message.channelId);
        if (!linkedChannel) return;

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

            const msg = await this.getMessageTransformer().transformMessage(message);

            const { messageId: webhookMessageId } =
                await webhookService.sendMessageViaDiscordWebhook(webhook, msg);

            await linkService.createMessageLink({
                discordMessageId: webhookMessageId,
                fluxerMessageId: message.id,
                guildLinkId: linkedChannel.guildLinkId,
                channelLinkId: linkedChannel.id,
            });
        } catch (error) {
            logger.error('Error relaying message to Discord:', error);
        }
    }
}

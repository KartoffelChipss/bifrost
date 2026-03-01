import { Message, OmitPartialGroupDMChannel } from 'discord.js';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';

export default class DiscordToFluxerMessageRelay extends MessageRelay<
    OmitPartialGroupDMChannel<Message<boolean>>
> {
    public async relayMessage(message: OmitPartialGroupDMChannel<Message<boolean>>): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        const linkedChannel = await linkService.getChannelLinkByDiscordChannelId(message.channelId);
        if (!linkedChannel) return;

        try {
            const webhook = await webhookService.getFluxerWebhook(
                linkedChannel.fluxerWebhookId,
                linkedChannel.fluxerWebhookToken
            );
            if (!webhook) {
                logger.warn(
                    `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message`
                );
                return;
            }

            const msg = await this.getMessageTransformer().transformMessage(message);

            const { messageId: webhookMessageId } =
                await webhookService.sendMessageViaFluxerWebhook(webhook, msg);

            await linkService.createMessageLink({
                discordMessageId: message.id,
                fluxerMessageId: webhookMessageId,
                guildLinkId: linkedChannel.guildLinkId,
                channelLinkId: linkedChannel.id,
            });
        } catch (error) {
            logger.error('Error relaying message to Fluxer:', error);
        }
    }
}

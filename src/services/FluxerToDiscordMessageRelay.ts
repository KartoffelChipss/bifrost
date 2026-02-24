import { Message, MessageAttachmentFlags } from '@fluxerjs/core';
import MessageRelay from './MessageRelay';
import logger from '../utils/logging/logger';
import { breakMentions, sanitizeMentions } from '../utils/sanitizeMentions';
import { buildFluxerStickerUrl } from '../utils/buildStickerUrl';

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

            const sanitizedContent = breakMentions(
                sanitizeMentions(message.content, {
                    resolveUser: (id) => {
                        const user = message.client.users.get(id);
                        return user ? user.username : null;
                    },
                    resolveRole: (id) => {
                        if (!message.guild) return null;
                        const role = message.guild.roles.get(id);
                        return role ? role.name : null;
                    },
                    resolveChannel: (id) => {
                        const channel = message.client.channels.get(id);
                        return channel ? channel.name : null;
                    },
                })
            );

            const attachments = message.attachments
                .filter(
                    (attachment) =>
                        attachment.url !== null &&
                        attachment.url !== undefined &&
                        attachment.url !== '' &&
                        !!attachment.url
                )
                .map((attachment) => ({
                    url: attachment.url!,
                    name: attachment.filename || 'attachment',
                    spoiler:
                        attachment.flags && attachment.flags & MessageAttachmentFlags.IS_SPOILER
                            ? true
                            : false,
                }));

            message.stickers.forEach((sticker) => {
                attachments.push({
                    url: buildFluxerStickerUrl(sticker.id, sticker.animated || false, 160),
                    name: sticker.name + '.webp',
                    spoiler: false,
                });
            });

            const { messageId: webhookMessageId } =
                await webhookService.sendMessageViaDiscordWebhook(webhook, {
                    content: sanitizedContent,
                    username: message.author.username,
                    avatarURL: message.author.avatarURL() || '',
                    attachments,
                });

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

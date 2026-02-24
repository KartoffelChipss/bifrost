import { Message, OmitPartialGroupDMChannel, TextChannel } from 'discord.js';
import MessageRelay from './MessageRelay';
import logger from '../utils/logging/logger';
import { sanitizeMentions } from '../utils/sanitizeMentions';
import { buildDiscordStickerUrl } from '../utils/buildStickerUrl';
import { getPollMessage } from '../utils/pollMessageFormatter';

export default class DiscordToFluxerMessageRelay extends MessageRelay<
    OmitPartialGroupDMChannel<Message<boolean>>
> {
    private stickerFormatToExtension(format: number): string {
        switch (format) {
            case 1:
                return 'png';
            case 2:
                return 'png';
            case 3:
                return 'json';
            case 4:
                return 'gif';
            default:
                return 'png';
        }
    }

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

            const sanitizedContent = sanitizeMentions(message.content, {
                resolveUser: (id) => {
                    const user = message.client.users.cache.get(id);
                    return user ? user.username : null;
                },
                resolveRole: (id) => {
                    if (!message.guild) return null;
                    const role = message.guild.roles.cache.get(id);
                    return role ? role.name : null;
                },
                resolveChannel: (id) => {
                    const channel = message.client.channels.cache.get(id);
                    return channel
                        ? channel instanceof TextChannel
                            ? channel.name
                            : channel.id
                        : null;
                },
            });

            const attachments = message.attachments.map((attachment) => ({
                url: attachment.url,
                name: attachment.name || 'attachment',
                spoiler: attachment.spoiler,
            }));

            message.stickers.forEach((sticker) => {
                attachments.push({
                    url: buildDiscordStickerUrl(sticker.id, 160),
                    name: sticker.name + '.' + this.stickerFormatToExtension(sticker.format),
                    spoiler: false,
                });
            });

            const isPollPresent =
                message.poll &&
                message.poll.question.text &&
                message.poll.answers.some((a) => a.text) &&
                message.poll.expiresTimestamp;

            const messageContent = isPollPresent
                ? getPollMessage(
                      message.poll!.question.text!,
                      message.poll!.answers.map((a) => a.text).filter((t): t is string => !!t),
                      message.poll!.expiresTimestamp!
                  )
                : sanitizedContent;

            await webhookService.sendMessageViaFluxerWebhook(webhook, {
                content: messageContent,
                username: message.author.username,
                avatarURL: message.author.avatarURL() || '',
                attachments: attachments,
            });
        } catch (error) {
            logger.error('Error relaying message to Fluxer:', error);
        }
    }
}

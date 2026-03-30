import { Message, MessageAttachmentFlags } from '@fluxerjs/core';
import MessageTransformer from './MessageTransformer';
import { WebhookMessageData } from '../WebhookService';
import { breakMentions, sanitizeMentions } from '../../utils/sanitizeMentions';
import { buildFluxerStickerUrl } from '../../utils/buildStickerUrl';
import WebhookEmbed from '../WebhookEmbed';
import { GeneralEmoji } from '../../utils/emojis';

export default class FluxerMessageTransformer extends MessageTransformer<
    Message,
    WebhookMessageData
> {
    private sanitizeContent(message: Message): string {
        return breakMentions(
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
    }

    public async transformMessage(
        message: Message,
        discordEmojis: GeneralEmoji[] = []
    ): Promise<WebhookMessageData> {
        const sanitizedContent = this.sanitizeContent(message);
        const emojiReplacedContent = this.replaceEmojis(
            sanitizedContent,
            discordEmojis
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
                    attachment.flags &&
                    attachment.flags & MessageAttachmentFlags.IS_SPOILER
                        ? true
                        : false,
            }));

        message.stickers.forEach((sticker) => {
            attachments.push({
                url: buildFluxerStickerUrl(
                    sticker.id,
                    sticker.animated || false,
                    160
                ),
                name: sticker.name + '.webp',
                spoiler: false,
            });
        });

        const embeds: WebhookEmbed[] = message.embeds.map((embed) =>
            WebhookEmbed.fromFluxerEmbed(embed)
        );

        if (message.referencedMessage) {
            const content = this.sanitizeContent(message.referencedMessage);
            embeds.unshift(
                new WebhookEmbed({
                    description: `${content}`,
                    color: 0x252529,
                    author: {
                        name: message.referencedMessage.author.username + ' ↩️',
                        iconURL:
                            message.referencedMessage.author.avatarURL() ||
                            undefined,
                    },
                    timestamp: null,
                })
            );
        }

        return {
            content: emojiReplacedContent,
            username: message.author.username,
            avatarURL: message.author.avatarURL() || '',
            attachments: attachments,
            embeds,
        };
    }
}

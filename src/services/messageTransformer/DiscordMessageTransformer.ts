import {
    Message,
    MessageFlags,
    OmitPartialGroupDMChannel,
    TextChannel,
} from 'discord.js';
import { WebhookMessageData } from '../WebhookService';
import MessageTransformer from './MessageTransformer';
import { sanitizeMentions } from '../../utils/sanitizeMentions';
import { buildDiscordStickerUrl } from '../../utils/buildStickerUrl';
import { getPollMessage } from '../../utils/pollMessageFormatter';
import WebhookEmbed from '../WebhookEmbed';
import { GeneralEmoji } from '../../utils/emojis';

type DiscordMessage = OmitPartialGroupDMChannel<Message<boolean>>;

export default class DiscordMessageTransformer extends MessageTransformer<
    DiscordMessage,
    WebhookMessageData
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

    private sanitizeContent(message: DiscordMessage): string {
        return sanitizeMentions(message.content, {
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
    }

    public async transformMessage(
        message: DiscordMessage,
        fluxerEmojis: GeneralEmoji[] = []
    ): Promise<WebhookMessageData> {
        const sanitizedContent = this.sanitizeContent(message);
        const emojiReplacedContent = this.replaceEmojis(
            sanitizedContent,
            fluxerEmojis
        );

        const attachments = message.attachments.map((attachment) => ({
            url: attachment.url,
            name: attachment.name || 'attachment',
            spoiler: attachment.spoiler,
        }));

        message.stickers.forEach((sticker) => {
            attachments.push({
                url: buildDiscordStickerUrl(sticker.id, 160),
                name:
                    sticker.name +
                    '.' +
                    this.stickerFormatToExtension(sticker.format),
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
                  message
                      .poll!.answers.map((a) => a.text)
                      .filter((t): t is string => !!t),
                  message.poll!.expiresTimestamp!
              )
            : emojiReplacedContent;

        const embeds: WebhookEmbed[] = message.embeds.map((embed) =>
            WebhookEmbed.fromDiscordEmbed(embed)
        );

        if (message.reference) {
            const referencedMessage = await message.fetchReference();
            const content = this.sanitizeContent(referencedMessage);
            const isForwarded = message.flags.has(MessageFlags.HasSnapshot);
            const refrenceEmoji = isForwarded ? '⏩' : '↩️';
            if (content && content.trim() !== '') {
                embeds.unshift(
                    new WebhookEmbed({
                        description: `${content}`,
                        color: 0x0b0d0e,
                        author: {
                            name:
                                referencedMessage.author.username +
                                ` ${refrenceEmoji}`,
                            iconURL:
                                referencedMessage.author.avatarURL() ||
                                undefined,
                        },
                    })
                );
            }
        }

        return {
            content: messageContent,
            username: message.author.username,
            avatarURL: message.author.avatarURL() || '',
            attachments: attachments,
            embeds,
        };
    }
}

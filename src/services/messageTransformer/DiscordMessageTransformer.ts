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
import WebhookEmbed, { WebhookEmbedFooter } from '../WebhookEmbed';
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

    private sanitizeContent(
        message: Pick<DiscordMessage, 'content' | 'client' | 'guild'>
    ): string {
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

    private buildForwardSourceFooter(
        message: DiscordMessage
    ): WebhookEmbedFooter | null {
        const reference = message.reference;
        if (!reference) return null;

        const guild = reference.guildId
            ? message.client.guilds.cache.get(reference.guildId)
            : null;
        const channel = message.client.channels.cache.get(reference.channelId);
        const channelName =
            channel instanceof TextChannel ? `#${channel.name}` : null;

        if (guild && channelName) {
            return { text: `From ${channelName} in ${guild.name}` };
        }
        if (guild) {
            return { text: `From ${guild.name}` };
        }
        return { text: 'From another server' };
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

        const embeds: WebhookEmbed[] = message.embeds
            .filter((embed) => embed.data.type === 'rich')
            .map((embed) => WebhookEmbed.fromDiscordEmbed(embed));

        if (message.reference) {
            const isForwarded = message.flags.has(MessageFlags.HasSnapshot);
            const referencedMessage = isForwarded
                ? message.messageSnapshots.first()
                : await message.fetchReference();
            if (!referencedMessage) {
                return {
                    content: messageContent,
                    username: message.author.username,
                    avatarURL: message.author.avatarURL() || '',
                    attachments: attachments,
                    embeds,
                };
            }
            const content = this.sanitizeContent(referencedMessage);
            const refrenceEmoji = isForwarded ? '⏩' : '↩️';
            if (content && content.trim() !== '') {
                const referencedAuthor = referencedMessage.author;
                const footer = isForwarded
                    ? this.buildForwardSourceFooter(message)
                    : null;
                embeds.unshift(
                    new WebhookEmbed({
                        description: `${content}`,
                        color: 0x0b0d0e,
                        author: {
                            name: referencedAuthor
                                ? `${referencedAuthor.username} ${refrenceEmoji}`
                                : `Forwarded message ${refrenceEmoji}`,
                            iconURL: referencedAuthor?.avatarURL() || undefined,
                        },
                        footer,
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

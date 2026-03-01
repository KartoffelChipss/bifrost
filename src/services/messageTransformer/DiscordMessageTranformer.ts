import { Message, OmitPartialGroupDMChannel, TextChannel } from 'discord.js';
import { WebhookMessageData } from '../WebhookService';
import MessageTransformer from './MessageTransformer';
import { sanitizeMentions } from '../../utils/sanitizeMentions';
import { buildDiscordStickerUrl } from '../../utils/buildStickerUrl';
import { getPollMessage } from '../../utils/pollMessageFormatter';
import WebhookEmbed from '../WebhookEmbed';

type DiscordMessage = OmitPartialGroupDMChannel<Message<boolean>>;

export default class DiscordMessageTransformer implements MessageTransformer<
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

    public async transformMessage(message: DiscordMessage): Promise<WebhookMessageData> {
        // console.log('Transforming Discord message:', message.toJSON());

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

        return {
            content: messageContent,
            username: message.author.username,
            avatarURL: message.author.avatarURL() || '',
            attachments: attachments,
            embeds: message.embeds.map((embed) => WebhookEmbed.fromDiscordEmbed(embed)),
        };
    }
}

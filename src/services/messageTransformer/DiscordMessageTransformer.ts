import {
    Message,
    MessageFlags,
    OmitPartialGroupDMChannel,
    TextChannel,
} from 'discord.js';
import { WebhookAttachment, WebhookMessageData } from '../WebhookService';
import MessageTransformer from './MessageTransformer';
import { sanitizeMentions } from '../../utils/sanitizeMentions';
import { buildDiscordStickerUrl } from '../../utils/buildStickerUrl';
import { fluxerFilename } from '../fluxerFiles'; // Fork
import { getPollMessage } from '../../utils/pollMessageFormatter';
import WebhookEmbed, { WebhookEmbedFooter } from '../WebhookEmbed';
import { GeneralEmoji } from '../../utils/emojis';
// Fork: mentions, pings, names, replies and stickers (src/relay-extras/fidelity).
import {
    discordFidelity,
    NO_FIDELITY,
    type FidelityView,
} from '../../relay-extras/fidelity';

type DiscordMessage = OmitPartialGroupDMChannel<Message<boolean>>;

/**
 * The author's avatar URL, falling back to Discord's default avatar.
 * Fork: Fluxer rejects a whole webhook message whose avatar_url is not
 * a URL (URLType in WebhookRequestSchemas.ts), and avatarURL() is null
 * for members without a custom avatar.
 */
export function authorAvatar(author: {
    avatarURL(): string | null;
    displayAvatarURL?: () => string;
}): string {
    return author.avatarURL() ?? author.displayAvatarURL?.() ?? '';
}

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

    private buildAttachments(
        source: Pick<DiscordMessage, 'attachments' | 'stickers'>
    ): WebhookAttachment[] {
        const attachments: WebhookAttachment[] =
            source.attachments?.map((attachment) => ({
                url: attachment.url,
                // Fork: Fluxer refuses names over 255 characters.
                name: fluxerFilename(attachment.name),
                spoiler: attachment.spoiler,
                size: attachment.size,
            })) ?? [];

        source.stickers?.forEach((sticker) => {
            attachments.push({
                url: buildDiscordStickerUrl(sticker.id, 160),
                name:
                    sticker.name +
                    '.' +
                    this.stickerFormatToExtension(sticker.format),
                spoiler: false,
            });
        });

        return attachments;
    }

    private buildRichEmbeds(
        source: Pick<DiscordMessage, 'embeds'>
    ): WebhookEmbed[] {
        return source.embeds
            .filter((embed) => embed.data.type === 'rich')
            .map((embed) => WebhookEmbed.fromDiscordEmbed(embed));
    }

    private sanitizeContent(
        message: Pick<DiscordMessage, 'content' | 'client' | 'guild'>,
        fidelity: FidelityView = NO_FIDELITY // Fork
    ): string {
        return sanitizeMentions(message.content, {
            mapMention: fidelity.mention, // Fork
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

    private buildQuoteEmbed(
        referencedMessage: { readonly author: DiscordMessage['author'] | null },
        content: string,
        refrenceEmoji: string,
        footer: WebhookEmbedFooter | null
    ): WebhookEmbed {
        const referencedAuthor = referencedMessage.author;
        return new WebhookEmbed({
            description: `${content}`,
            color: 0x0b0d0e,
            author: {
                name: referencedAuthor
                    ? `${referencedAuthor.username} ${refrenceEmoji}`
                    : `Forwarded message ${refrenceEmoji}`,
                iconURL: referencedAuthor?.avatarURL() || undefined,
            },
            footer,
        });
    }

    /**
     * Fork: the quote a native reply replaces, or null when the replied-to
     * message is gone or has no text. A lost quote never costs the copy.
     */
    private async nativeReplyQuote(
        message: DiscordMessage
    ): Promise<WebhookEmbed | null> {
        const referenced = await message.fetchReference().catch(() => null);
        if (!referenced) return null;
        const content = this.sanitizeContent(referenced);
        if (!content || content.trim() === '') return null;
        return this.buildQuoteEmbed(referenced, content, '↩️', null);
    }

    public async transformMessage(
        message: DiscordMessage,
        fluxerEmojis: GeneralEmoji[] = []
    ): Promise<WebhookMessageData> {
        const fidelity = await discordFidelity(message); // Fork
        const sanitizedContent = this.sanitizeContent(message, fidelity);
        const emojiReplacedContent = this.replaceEmojis(
            fidelity.emojis(sanitizedContent, fluxerEmojis), // Fork
            fluxerEmojis
        );

        const attachments = this.buildAttachments(message);

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

        const embeds: WebhookEmbed[] = this.buildRichEmbeds(message);

        // Fork: a native reply on Fluxer replaces the quote embed, which
        // is kept aside for a rejected send or an edit
        // (src/relay-extras/fidelity/fallback.ts).
        if (message.reference && fidelity.nativeReply) {
            return fidelity.finish(
                {
                    content: messageContent,
                    username: message.author.username,
                    avatarURL: authorAvatar(message.author),
                    attachments: attachments,
                    embeds,
                },
                await this.nativeReplyQuote(message)
            );
        }

        if (message.reference) {
            const isForwarded = message.flags.has(MessageFlags.HasSnapshot);
            const referencedMessage = isForwarded
                ? message.messageSnapshots.first()
                : await message.fetchReference();
            if (!referencedMessage) {
                return fidelity.finish({
                    content: messageContent,
                    username: message.author.username,
                    avatarURL: authorAvatar(message.author),
                    attachments: attachments,
                    embeds,
                }); // Fork
            }

            if (isForwarded) {
                attachments.push(...this.buildAttachments(referencedMessage));
                embeds.push(...this.buildRichEmbeds(referencedMessage));
            }

            const content = this.sanitizeContent(referencedMessage);
            const refrenceEmoji = isForwarded ? '⏩' : '↩️';
            if (content && content.trim() !== '') {
                const footer = isForwarded
                    ? this.buildForwardSourceFooter(message)
                    : null;
                embeds.unshift(
                    this.buildQuoteEmbed(
                        referencedMessage,
                        content,
                        refrenceEmoji,
                        footer
                    )
                ); // Fork: shared with nativeReplyQuote
            } else if (attachments.length > 0 || embeds.length > 0) {
                embeds.unshift(
                    new WebhookEmbed({
                        description: `Forwarded message ${refrenceEmoji}`,
                        color: 0x0b0d0e,
                        footer: this.buildForwardSourceFooter(message),
                    })
                );
            }
        }

        return fidelity.finish({
            content: messageContent,
            username: message.author.username,
            avatarURL: authorAvatar(message.author),
            attachments: attachments,
            embeds,
        }); // Fork
    }
}

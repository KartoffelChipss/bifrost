import {
    DiscordAPIError,
    EmbedBuilder,
    RESTJSONErrorCodes,
    type Client,
    type SendableChannels,
} from 'discord.js';
import { withTimeout } from '../addons/host';
import type { SendNotice } from './notices';
import type { StatusEmbed } from './status';
import type { StatusMessenger } from './statusBoard';

/** Discord cuts a message at 2000 characters. */
const MAX_NOTICE_LENGTH = 1_900;
const SEND_TIMEOUT_MS = 15_000;

/** No message is ever allowed to ping anyone. */
const NO_MENTIONS = { parse: [] };

type IsChannelLinked = (channelId: string) => Promise<boolean>;

/**
 * The admin channel, ready to post to. It refuses a bridged channel,
 * because the relay would copy the post to the other server.
 */
async function adminChannel(
    client: Client,
    isChannelLinked: IsChannelLinked,
    channelId: string
): Promise<SendableChannels> {
    if (await isChannelLinked(channelId)) {
        throw new Error('the admin channel is a bridged channel');
    }
    const channel = await withTimeout(
        client.channels.fetch(channelId),
        SEND_TIMEOUT_MS,
        'admin channel lookup'
    );
    if (!channel?.isSendable()) {
        throw new Error('the admin channel cannot be posted to');
    }
    return channel;
}

/** Posts notices to a Discord channel; never to a bridged one. */
export function discordNoticeSender(
    client: Client,
    isChannelLinked: IsChannelLinked
): SendNotice {
    return async (channelId, text) => {
        const channel = await adminChannel(client, isChannelLinked, channelId);
        const content =
            text.length > MAX_NOTICE_LENGTH
                ? `${text.slice(0, MAX_NOTICE_LENGTH)}\n…`
                : text;
        await withTimeout<unknown>(
            channel.send({ content, allowedMentions: NO_MENTIONS }),
            SEND_TIMEOUT_MS,
            'admin channel post'
        );
    };
}

function toEmbed(embed: StatusEmbed): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle(embed.title)
        .setDescription(embed.description)
        .setColor(embed.color);
}

/** True for Discord's "Unknown Message" (10008): the message is gone. */
export function isUnknownMessage(error: unknown): boolean {
    return (
        error instanceof DiscordAPIError &&
        error.code === RESTJSONErrorCodes.UnknownMessage
    );
}

/** Posts a status embed. Resolves to the new message's ID. */
async function postStatus(
    channel: SendableChannels,
    embed: StatusEmbed
): Promise<string> {
    const message = await withTimeout<{ readonly id: string }>(
        channel.send({
            embeds: [toEmbed(embed)],
            allowedMentions: NO_MENTIONS,
        }),
        SEND_TIMEOUT_MS,
        'status message post'
    );
    return message.id;
}

/** Edits a status embed; 'missing' when Discord no longer has it. */
async function editStatus(
    channel: SendableChannels,
    messageId: string,
    embed: StatusEmbed
): Promise<'edited' | 'missing'> {
    try {
        await withTimeout<unknown>(
            channel.messages.edit(messageId, {
                embeds: [toEmbed(embed)],
                allowedMentions: NO_MENTIONS,
            }),
            SEND_TIMEOUT_MS,
            'status message edit'
        );
        return 'edited';
    } catch (error) {
        if (isUnknownMessage(error)) return 'missing';
        throw error;
    }
}

/** Posts and edits the status message; never in a bridged channel. */
export function discordStatusMessenger(
    client: Client,
    isChannelLinked: IsChannelLinked
): StatusMessenger {
    const channel = (id: string) => adminChannel(client, isChannelLinked, id);
    return {
        post: async (channelId, embed) =>
            postStatus(await channel(channelId), embed),
        edit: async (channelId, messageId, embed) =>
            editStatus(await channel(channelId), messageId, embed),
    };
}

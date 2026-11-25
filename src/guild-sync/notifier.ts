import type { Client } from 'discord.js';
import { withTimeout } from '../addons/host';
import type { SendNotice } from './notices';

/** Discord cuts a message at 2000 characters. */
const MAX_NOTICE_LENGTH = 1_900;
const SEND_TIMEOUT_MS = 15_000;

/**
 * Posts notices to a Discord channel. It refuses a bridged channel, because
 * the relay would copy the notice to the other server.
 */
export function discordNoticeSender(
    client: Client,
    isChannelLinked: (channelId: string) => Promise<boolean>
): SendNotice {
    return async (channelId, text) => {
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
        const content =
            text.length > MAX_NOTICE_LENGTH
                ? `${text.slice(0, MAX_NOTICE_LENGTH)}\n…`
                : text;
        await withTimeout<unknown>(
            channel.send({ content, allowedMentions: { parse: [] } }),
            SEND_TIMEOUT_MS,
            'admin channel post'
        );
    };
}

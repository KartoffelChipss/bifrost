import type { ChannelProgress } from '../../src/archive/types';

/** A Discord API message as the archive reads it. */
export function rawMessage(
    id: string,
    fields: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        id,
        channel_id: '200',
        author: {
            id: '300',
            username: 'alice',
            global_name: 'Alice',
            avatar: 'a1',
        },
        timestamp: '2018-08-22T15:03:56.434000+00:00',
        edited_timestamp: null,
        content: `message ${id}`,
        attachments: [],
        ...fields,
    };
}

export function attachment(id: string, size = 10) {
    return {
        id,
        filename: `${id}.png`,
        size,
        url: `https://cdn.discordapp.com/attachments/200/${id}/${id}.png?ex=1`,
        content_type: 'image/png',
    };
}

export function progress(
    fields: Partial<ChannelProgress> = {}
): ChannelProgress {
    return {
        channelId: '200',
        guildId: '100',
        kind: 'channel',
        parentId: null,
        afterId: '0',
        status: 'walking',
        messages: 0,
        failures: 0,
        walkedAt: null,
        ...fields,
    };
}

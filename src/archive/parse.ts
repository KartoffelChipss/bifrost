import type {
    FileRef,
    MemberSnapshot,
    RawAttachment,
    RawMessage,
    RawSticker,
    RawUser,
} from './types';

/**
 * Checks Discord API objects at the trust boundary. A message missing a
 * field the archive needs is refused (null) rather than half-stored.
 */

type Json = Readonly<Record<string, unknown>>;

const SNOWFLAKE = /^\d{1,25}$/;
/** Discord allows at most 10 attachments and 3 stickers per message. */
const MAX_ATTACHMENTS = 10;
const MAX_STICKERS = 3;

const isObject = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (o: Json, key: string): string | null =>
    typeof o[key] === 'string' ? (o[key] as string) : null;

const id = (o: Json, key: string): string | null => {
    const value = str(o, key);
    return value !== null && SNOWFLAKE.test(value) ? value : null;
};

function parseUser(value: unknown): RawUser | null {
    if (!isObject(value)) return null;
    const userId = id(value, 'id');
    const username = str(value, 'username');
    if (!userId || username === null) return null;
    return {
        id: userId,
        username,
        global_name: str(value, 'global_name'),
        avatar: str(value, 'avatar'),
    };
}

function parseAttachment(value: unknown): RawAttachment | null {
    if (!isObject(value)) return null;
    const attachmentId = id(value, 'id');
    const url = str(value, 'url');
    if (!attachmentId || !url?.startsWith('https://')) return null;
    const size = value.size;
    return {
        id: attachmentId,
        filename: str(value, 'filename') ?? attachmentId,
        size: typeof size === 'number' && size >= 0 ? size : null,
        url,
        content_type: str(value, 'content_type'),
    };
}

function parseSticker(value: unknown): RawSticker | null {
    if (!isObject(value)) return null;
    const stickerId = id(value, 'id');
    const format = value.format_type;
    if (!stickerId || typeof format !== 'number') return null;
    return {
        id: stickerId,
        name: str(value, 'name') ?? stickerId,
        format_type: format,
    };
}

function list<T>(
    value: unknown,
    parse: (v: unknown) => T | null,
    max: number
): T[] {
    if (!Array.isArray(value)) return [];
    const out: T[] = [];
    for (const item of value.slice(0, max)) {
        const parsed = parse(item);
        if (parsed) out.push(parsed);
    }
    return out;
}

/** A Discord API message, or null when it lacks what the archive needs. */
export function parseRawMessage(value: unknown): RawMessage | null {
    if (!isObject(value)) return null;
    const messageId = id(value, 'id');
    const channelId = id(value, 'channel_id');
    const author = parseUser(value.author);
    const timestamp = str(value, 'timestamp');
    if (!messageId || !channelId || !author || !timestamp) return null;
    if (Number.isNaN(Date.parse(timestamp))) return null;
    return {
        id: messageId,
        channel_id: channelId,
        author,
        timestamp,
        edited_timestamp: str(value, 'edited_timestamp'),
        webhook_id: id(value, 'webhook_id'),
        attachments: list(value.attachments, parseAttachment, MAX_ATTACHMENTS),
        stickers: list(value.sticker_items, parseSticker, MAX_STICKERS),
        json: value,
    };
}

/** A member snapshot from Discord's guild member object. */
export function parseRawMember(
    guildId: string,
    value: unknown
): MemberSnapshot | null {
    if (!isObject(value)) return null;
    const user = parseUser(value.user);
    if (!user) return null;
    return {
        ...memberFromUser(guildId, user),
        nick: str(value, 'nick'),
        serverAvatar: str(value, 'avatar'),
        inGuild: true,
    };
}

/** The snapshot of someone who is no longer a member: the user alone. */
export function memberFromUser(guildId: string, user: RawUser): MemberSnapshot {
    return {
        guildId,
        userId: user.id,
        username: user.username,
        globalName: user.global_name,
        nick: null,
        avatar: user.avatar,
        serverAvatar: null,
        inGuild: false,
    };
}

/** Discord's sticker image formats and their file extensions. */
const STICKER_EXTENSIONS: Readonly<Record<number, string>> = {
    1: 'png',
    2: 'png',
    3: 'json',
    4: 'gif',
};

function stickerFile(messageId: string, sticker: RawSticker): FileRef {
    const ext = STICKER_EXTENSIONS[sticker.format_type] ?? 'png';
    return {
        kind: 'sticker',
        sourceId: sticker.id,
        messageId,
        filename: `${sticker.name}.${ext}`,
        size: null,
        contentType: null,
        url: `https://cdn.discordapp.com/stickers/${sticker.id}.${ext}`,
    };
}

/** The files a message carries: its attachments and sticker images. */
export function filesOf(message: RawMessage): FileRef[] {
    const attachments = message.attachments.map(
        (a): FileRef => ({
            kind: 'attachment',
            sourceId: a.id,
            messageId: message.id,
            filename: a.filename,
            size: a.size,
            contentType: a.content_type,
            url: a.url,
        })
    );
    const stickers = message.stickers.map((s) => stickerFile(message.id, s));
    return [...attachments, ...stickers];
}

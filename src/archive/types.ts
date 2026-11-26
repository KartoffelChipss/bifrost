/**
 * Shapes the Discord archive reads from Discord's API and keeps. Only the
 * fields the archive uses are typed; the whole API object is stored as is.
 * IDs are snowflakes as strings.
 */

export interface RawUser {
    readonly id: string;
    readonly username: string;
    readonly global_name: string | null;
    readonly avatar: string | null;
}

export interface RawAttachment {
    readonly id: string;
    readonly filename: string;
    readonly size: number | null;
    readonly url: string;
    readonly content_type: string | null;
}

export interface RawSticker {
    readonly id: string;
    readonly name: string;
    /** 1 PNG, 2 APNG, 3 Lottie, 4 GIF (Discord's StickerFormatType). */
    readonly format_type: number;
}

/** A Discord API message, checked for the fields the archive uses. */
export interface RawMessage {
    readonly id: string;
    readonly channel_id: string;
    readonly author: RawUser;
    readonly timestamp: string;
    readonly edited_timestamp: string | null;
    readonly webhook_id: string | null;
    readonly attachments: readonly RawAttachment[];
    readonly stickers: readonly RawSticker[];
    /** The object exactly as Discord sent it. */
    readonly json: Readonly<Record<string, unknown>>;
}

/** A guild member's name and avatars, or the user alone after they left. */
export interface MemberSnapshot {
    readonly guildId: string;
    readonly userId: string;
    readonly username: string;
    readonly globalName: string | null;
    readonly nick: string | null;
    readonly avatar: string | null;
    readonly serverAvatar: string | null;
    readonly inGuild: boolean;
}

/** One channel or thread the archive walks. */
export interface ArchiveTarget {
    readonly channelId: string;
    readonly guildId: string;
    readonly kind: 'channel' | 'thread';
    readonly parentId: string | null;
}

export type ChannelStatus = 'walking' | 'current' | 'failed' | 'forbidden';

export interface ChannelProgress extends ArchiveTarget {
    readonly afterId: string;
    readonly status: ChannelStatus;
    readonly messages: number;
    readonly failures: number;
    readonly walkedAt: Date | null;
}

export type FileKind = 'attachment' | 'sticker';
export type FileStatus = 'pending' | 'stored' | 'gone' | 'failed';

/** A file a message carries, to be stored once. */
export interface FileRef {
    readonly kind: FileKind;
    readonly sourceId: string;
    readonly messageId: string;
    readonly filename: string;
    readonly size: number | null;
    readonly contentType: string | null;
    readonly url: string;
}

/** Discord's API, as the archive reads it. */
export interface ArchiveSource {
    /** Up to `limit` raw messages after `afterId`, in any order. */
    page(channelId: string, afterId: string, limit: number): Promise<unknown[]>;
    /** One raw message, or null when it is gone. */
    message(channelId: string, messageId: string): Promise<unknown | null>;
    /** The raw guild member, or null when they are not a member. */
    member(guildId: string, userId: string): Promise<unknown | null>;
}

/** Where file bytes go: content-addressed, so one file is kept once. */
export interface ArchiveFileStore {
    /** Downloads `url` and stores it. Throws FileGoneError for 403/404/410. */
    put(url: string): Promise<{ sha256: string; size: number }>;
    /** Deletes stored bytes no row refers to any more. */
    remove(sha256: string): Promise<void>;
    /** Free bytes on the volume. */
    freeBytes(): Promise<number>;
}

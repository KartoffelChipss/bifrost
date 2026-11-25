/**
 * The structure of one server at one moment, in a shape both platforms
 * share. Readers build it from REST responses; the diff and the guards work
 * only on this shape, so they run without any network.
 *
 * Bitfields are decimal strings so a snapshot round-trips through JSONB.
 */

import type { SnapshotSide } from '../addons/db/schema';

/** Channel kinds guild-sync manages. Anything else is skipped. */
export const SYNCED_CHANNEL_TYPES = {
    0: 'text',
    2: 'voice',
    4: 'category',
    5: 'announcement',
    15: 'forum',
} as const;

export type ChannelKind =
    (typeof SYNCED_CHANNEL_TYPES)[keyof typeof SYNCED_CHANNEL_TYPES];

export interface RoleSnap {
    readonly id: string;
    readonly name: string;
    readonly color: number;
    readonly hoist: boolean;
    readonly mentionable: boolean;
    readonly permissions: string;
    readonly position: number;
    /** Bot, integration or booster role. Never synced. */
    readonly managed: boolean;
    /** The role's unicode emoji icon. Undefined in older snapshots. */
    readonly unicodeEmoji?: string | null;
    /**
     * The role's image icon, as the platform's own hash. Hashes differ
     * across platforms, so the diff compares it only with the last write.
     */
    readonly icon?: string | null;
}

export interface OverwriteSnap {
    readonly id: string;
    /** 0 = role, 1 = member, as on both APIs. */
    readonly type: 0 | 1;
    readonly allow: string;
    readonly deny: string;
}

export interface ChannelSnap {
    readonly id: string;
    /** Raw API channel type. */
    readonly type: number;
    readonly name: string;
    readonly position: number;
    readonly parentId: string | null;
    readonly topic: string | null;
    readonly nsfw: boolean;
    readonly rateLimitPerUser: number;
    readonly bitrate: number | null;
    readonly userLimit: number | null;
    readonly overwrites: readonly OverwriteSnap[];
    /** Names of the tags a forum offers, in order. Empty for other kinds. */
    readonly tags: readonly string[];
    /**
     * False when the reading bot cannot bridge this channel: it lacks View
     * Channel or Manage Webhooks there. Undefined when not checked.
     */
    readonly bridgeable?: boolean;
    /** Minutes before new threads archive. Text, announcement, forum. */
    readonly defaultAutoArchive?: number | null;
    /** Slowmode in seconds given to new threads. */
    readonly defaultThreadSlowmode?: number | null;
    /** Forum settings. Undefined for other kinds and in older snapshots. */
    readonly forum?: ForumSnap;
}

/** An emoji as both APIs give it: a custom emoji ID or a unicode name. */
export interface EmojiRef {
    readonly emojiId: string | null;
    readonly emojiName: string | null;
}

export interface ForumTagSnap extends EmojiRef {
    readonly name: string;
    readonly moderated: boolean;
}

export interface ForumSnap {
    readonly defaultReaction: EmojiRef | null;
    readonly sortOrder: number | null;
    readonly layout: number | null;
    /** The tags with their details, in the order of `ChannelSnap.tags`. */
    readonly tags: readonly ForumTagSnap[];
}

/** Server settings that point at channels or set member defaults. */
export interface GuildSettingsSnap {
    readonly systemChannelId: string | null;
    readonly afkChannelId: string | null;
    readonly afkTimeout: number;
    readonly verificationLevel: number;
    readonly defaultNotifications: number;
    readonly explicitContentFilter: number;
}

/** Channel types that can hold threads or posts: text, announcement, forum. */
export const THREAD_PARENT_TYPES: ReadonlySet<number> = new Set([0, 5, 15]);

/**
 * Channel types the relay bridges: text, voice (its text chat),
 * announcement, and forum (whose webhook starts posts).
 */
export const LINKED_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 2, 5, 15]);

/** Thread types that are synced: announcement, public and private. */
export const SYNCED_THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

/** A private thread, seen only by its members and moderators. */
export const PRIVATE_THREAD_TYPE = 12;

/** A thread in a text channel, or a post in a forum. */
export interface ThreadSnap {
    readonly id: string;
    readonly parentId: string;
    readonly name: string;
    readonly archived: boolean;
    readonly locked: boolean;
    /** Names of the applied forum tags, sorted. */
    readonly tags: readonly string[];
    /** Undefined in older snapshots: treated as public. */
    readonly private?: boolean;
    /** Private threads: whether members may invite others. */
    readonly invitable?: boolean;
    /** Pinned to the top of its forum. */
    readonly pinned?: boolean;
    readonly rateLimitPerUser?: number;
    /** Minutes of inactivity before it archives. */
    readonly autoArchiveDuration?: number;
}

export interface EmojiSnap {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
}

export interface StickerSnap {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly tags: string;
}

/** The bot's own standing on this server. Only the destination needs it. */
export interface BotSnap {
    readonly userId: string;
    readonly roleIds: readonly string[];
    readonly isOwner: boolean;
}

export interface GuildSnapshot {
    readonly side: SnapshotSide;
    readonly guildId: string;
    readonly name: string;
    readonly icon: string | null;
    readonly banner: string | null;
    /** The @everyone role. Its ID equals the guild ID on both platforms. */
    readonly everyoneRoleId: string;
    readonly roles: readonly RoleSnap[];
    readonly channels: readonly ChannelSnap[];
    readonly emojis: readonly EmojiSnap[];
    readonly stickers: readonly StickerSnap[];
    readonly threads: readonly ThreadSnap[];
    /**
     * Channels whose thread list is incomplete: unreadable (for example
     * without Read Message History) or with more archived threads than a
     * read pages through. No thread in these channels counts as missing,
     * nor any thread whose parent cannot be told, so nothing is removed
     * on an incomplete list.
     */
    readonly threadGaps: readonly string[];
    /**
     * Channels whose archived private threads could not be listed (the
     * bot needs Manage Threads). Private thread copies never count as
     * missing while this is not empty.
     */
    readonly privateThreadGaps?: readonly string[];
    /** Undefined in older snapshots. */
    readonly settings?: GuildSettingsSnap;
    readonly bot: BotSnap | null;
}

export interface ObjectCounts {
    readonly roles: number;
    readonly channels: number;
    readonly emojis: number;
    readonly stickers: number;
}

export function countObjects(snapshot: GuildSnapshot): ObjectCounts {
    return {
        roles: snapshot.roles.length,
        channels: snapshot.channels.length,
        emojis: snapshot.emojis.length,
        stickers: snapshot.stickers.length,
    };
}

/** Max depth of a snapshot: snapshot > list > object > overwrites > item. */
const MAX_JSON_DEPTH = 8;

function sortKeys(value: unknown, depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) throw new RangeError('snapshot is too deep');
    if (Array.isArray(value)) return value.map((v) => sortKeys(v, depth + 1));
    if (typeof value !== 'object' || value === null) return value;
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return Object.fromEntries(
        entries.map(([k, v]) => [k, sortKeys(v, depth + 1)])
    );
}

/**
 * JSON with sorted keys. Postgres JSONB reorders keys, so a plain
 * JSON.stringify of a stored snapshot never equals a fresh one.
 */
export function stableJson(value: unknown): string {
    return JSON.stringify(sortKeys(value, 0));
}

export function channelKind(type: number): ChannelKind | null {
    const kinds: Readonly<Record<number, ChannelKind>> = SYNCED_CHANNEL_TYPES;
    return kinds[type] ?? null;
}

/**
 * Every channel and thread an exclusion list covers: the listed channels,
 * the channels in a listed category, and the threads inside any of them.
 */
export function excludedIds(
    snapshot: Pick<GuildSnapshot, 'channels' | 'threads'>,
    listed: ReadonlySet<string>
): Set<string> {
    const out = new Set<string>();
    if (listed.size === 0) return out;
    for (const channel of snapshot.channels) {
        const inCategory =
            channel.parentId !== null && listed.has(channel.parentId);
        if (listed.has(channel.id) || inCategory) out.add(channel.id);
    }
    for (const thread of snapshot.threads) {
        if (out.has(thread.parentId)) out.add(thread.id);
    }
    return out;
}

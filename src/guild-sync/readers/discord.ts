import {
    ChannelFlags,
    ChannelType,
    DiscordAPIError,
    PermissionFlagsBits,
    RESTJSONErrorCodes,
    type AnyThreadChannel,
    type Client,
    type ForumChannel,
    type Guild,
    type GuildEmoji,
    type GuildMember,
    type NonThreadGuildBasedChannel,
    type PermissionOverwrites,
    type Role,
    type Sticker,
} from 'discord.js';
import type { ReadResult } from '../health';
import type { SyncKind } from '../ops';
import type {
    ChannelSnap,
    EmojiRef,
    EmojiSnap,
    ForumSnap,
    GuildSettingsSnap,
    GuildSnapshot,
    OverwriteSnap,
    RoleSnap,
    StickerSnap,
    ThreadSnap,
} from '../snapshot';
import { SYNCED_THREAD_TYPES, THREAD_PARENT_TYPES } from '../snapshot';
import {
    READ_TIMEOUT_MS,
    guardedLookup,
    guardedRead,
    type GuildReader,
} from './reader';

const UNKNOWN_CODES: ReadonlySet<unknown> = new Set([
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.UnknownRole,
    RESTJSONErrorCodes.UnknownEmoji,
    RESTJSONErrorCodes.UnknownSticker,
]);

function isUnknown(error: unknown): boolean {
    return error instanceof DiscordAPIError && UNKNOWN_CODES.has(error.code);
}

function overwrite(o: PermissionOverwrites): OverwriteSnap {
    return {
        id: o.id,
        type: o.type === 1 ? 1 : 0,
        allow: o.allow.bitfield.toString(),
        deny: o.deny.bitfield.toString(),
    };
}

/** What a link needs: the relay reads the channel and owns a webhook. */
const BRIDGE_BITS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ManageWebhooks,
];

export function discordChannel(
    c: NonThreadGuildBasedChannel,
    me: GuildMember | null = null
): ChannelSnap {
    const bridgeable = me ? c.permissionsFor(me).has(BRIDGE_BITS) : undefined;
    return {
        id: c.id,
        type: c.type,
        name: c.name,
        position: c.rawPosition,
        parentId: c.parentId,
        topic: 'topic' in c ? (c.topic ?? null) : null,
        nsfw: 'nsfw' in c ? c.nsfw : false,
        rateLimitPerUser:
            'rateLimitPerUser' in c ? (c.rateLimitPerUser ?? 0) : 0,
        bitrate: 'bitrate' in c ? c.bitrate : null,
        userLimit: 'userLimit' in c ? c.userLimit : null,
        overwrites: c.permissionOverwrites.cache.map(overwrite),
        tags: 'availableTags' in c ? c.availableTags.map((t) => t.name) : [],
        ...(bridgeable === undefined ? {} : { bridgeable }),
        ...threadDefaults(c),
        ...(c.type === ChannelType.GuildForum ? { forum: forumOf(c) } : {}),
    };
}

/** What new threads get by default, for channels that hold threads. */
function threadDefaults(
    c: NonThreadGuildBasedChannel
): Pick<ChannelSnap, 'defaultAutoArchive' | 'defaultThreadSlowmode'> {
    if (!('defaultThreadRateLimitPerUser' in c)) return {};
    return {
        defaultAutoArchive: c.defaultAutoArchiveDuration ?? null,
        defaultThreadSlowmode: c.defaultThreadRateLimitPerUser ?? null,
    };
}

const emojiRef = (
    emoji: { id: string | null; name: string | null } | null
): EmojiRef | null =>
    emoji ? { emojiId: emoji.id ?? null, emojiName: emoji.name ?? null } : null;

function forumOf(c: ForumChannel): ForumSnap {
    return {
        defaultReaction: emojiRef(c.defaultReactionEmoji),
        sortOrder: c.defaultSortOrder ?? null,
        layout: c.defaultForumLayout ?? null,
        tags: c.availableTags.map((tag) => ({
            name: tag.name,
            moderated: tag.moderated,
            ...(emojiRef(tag.emoji) ?? { emojiId: null, emojiName: null }),
        })),
    };
}

/**
 * Archived threads are read 100 at a time, up to this many pages a channel.
 * A channel with more is reported as a gap rather than cut off silently.
 */
export const MAX_ARCHIVE_PAGES = 20;

function discordThread(
    t: AnyThreadChannel,
    tagNames: ReadonlyMap<string, string>
): ThreadSnap {
    const tags: string[] = [];
    for (const id of t.appliedTags) {
        const name = tagNames.get(id);
        if (name !== undefined) tags.push(name);
    }
    const isPrivate = t.type === ChannelType.PrivateThread;
    return {
        id: t.id,
        parentId: t.parentId ?? '',
        name: t.name,
        archived: t.archived ?? false,
        locked: t.locked ?? false,
        tags: tags.sort(),
        private: isPrivate,
        ...(isPrivate ? { invitable: t.invitable ?? true } : {}),
        pinned: t.flags.has(ChannelFlags.Pinned),
        rateLimitPerUser: t.rateLimitPerUser ?? 0,
        autoArchiveDuration: t.autoArchiveDuration ?? 1440,
    };
}

/**
 * The archived private threads of a text channel, paged like public ones.
 * Listing them needs Manage Threads, so a refusal is reported, not thrown,
 * and so is a list longer than MAX_ARCHIVE_PAGES.
 */
async function archivedPrivate(
    parent: NonThreadGuildBasedChannel
): Promise<{ threads: AnyThreadChannel[]; readable: boolean }> {
    if (parent.type !== ChannelType.GuildText) {
        return { threads: [], readable: true };
    }
    try {
        const result = await archivedThreads(parent, 'private');
        return { threads: result.threads, readable: result.complete };
    } catch {
        return { threads: [], readable: false };
    }
}

/**
 * The archived threads of one channel, newest first. `complete` is false
 * when more pages remain after MAX_ARCHIVE_PAGES.
 */
async function archivedThreads(
    parent: NonThreadGuildBasedChannel,
    type: 'public' | 'private' = 'public'
): Promise<{ threads: AnyThreadChannel[]; complete: boolean }> {
    if (!('threads' in parent)) return { threads: [], complete: true };
    const found: AnyThreadChannel[] = [];
    let before: AnyThreadChannel | undefined;
    for (let page = 0; page < MAX_ARCHIVE_PAGES; page++) {
        const result = await parent.threads.fetchArchived(
            { type, limit: 100, before },
            false
        );
        found.push(...result.threads.values());
        before = result.threads.last();
        if (!result.hasMore || !before) {
            return { threads: found, complete: true };
        }
    }
    return { threads: found, complete: false };
}

/**
 * Lists active and archived threads. A channel whose archive cannot be read
 * is reported as a gap and never fails the whole read.
 */
async function readThreads(
    guild: Guild,
    channels: readonly NonThreadGuildBasedChannel[]
): Promise<{ threads: ThreadSnap[]; gaps: string[]; privateGaps: string[] }> {
    const tagNames = new Map<string, string>();
    for (const channel of channels) {
        if (!('availableTags' in channel)) continue;
        for (const tag of channel.availableTags) tagNames.set(tag.id, tag.name);
    }
    const all = new Map<string, AnyThreadChannel>();
    const active = await guild.channels.fetchActiveThreads(false);
    for (const thread of active.threads.values()) all.set(thread.id, thread);
    const gaps: string[] = [];
    const privateGaps: string[] = [];
    for (const parent of channels) {
        if (!THREAD_PARENT_TYPES.has(parent.type)) continue;
        try {
            const archived = await archivedThreads(parent);
            for (const thread of archived.threads) all.set(thread.id, thread);
            if (!archived.complete) gaps.push(parent.id);
        } catch {
            gaps.push(parent.id);
        }
        const hidden = await archivedPrivate(parent);
        for (const thread of hidden.threads) all.set(thread.id, thread);
        if (!hidden.readable) privateGaps.push(parent.id);
    }
    const threads = [...all.values()]
        .filter((t) => SYNCED_THREAD_TYPES.has(t.type) && t.parentId !== null)
        .map((t) => discordThread(t, tagNames));
    return { threads, gaps, privateGaps };
}

export function discordRole(r: Role): RoleSnap {
    return {
        id: r.id,
        name: r.name,
        color: r.colors.primaryColor,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: r.permissions.bitfield.toString(),
        position: r.rawPosition,
        managed: r.managed,
        unicodeEmoji: r.unicodeEmoji ?? null,
        icon: r.icon ?? null,
    };
}

function settingsOf(guild: Guild): GuildSettingsSnap {
    return {
        systemChannelId: guild.systemChannelId,
        afkChannelId: guild.afkChannelId,
        afkTimeout: guild.afkTimeout,
        verificationLevel: guild.verificationLevel,
        defaultNotifications: guild.defaultMessageNotifications,
        explicitContentFilter: guild.explicitContentFilter,
    };
}

const discordEmoji = (e: GuildEmoji): EmojiSnap => ({
    id: e.id,
    name: e.name ?? '',
    animated: e.animated ?? false,
});

const discordSticker = (s: Sticker): StickerSnap => ({
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    tags: s.tags ?? '',
});

async function snapshotOf(guild: Guild): Promise<GuildSnapshot> {
    const force = { force: true };
    const [channels, roles, emojis, stickers, me] = await Promise.all([
        guild.channels.fetch(undefined, force),
        guild.roles.fetch(undefined, force),
        guild.emojis.fetch(undefined, force),
        guild.stickers.fetch(undefined, force),
        guild.members.fetchMe(),
    ]);
    const listed = [...channels.values()].filter(
        (c): c is NonThreadGuildBasedChannel => c !== null
    );
    const { threads, gaps, privateGaps } = await readThreads(guild, listed);
    return {
        side: 'discord',
        guildId: guild.id,
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner,
        everyoneRoleId: guild.id,
        roles: roles.map(discordRole),
        channels: listed.map((c) => discordChannel(c, me)),
        emojis: emojis.map(discordEmoji),
        stickers: stickers.map(discordSticker),
        threads,
        threadGaps: gaps,
        privateThreadGaps: privateGaps,
        settings: settingsOf(guild),
        bot: null,
    };
}

/** Reads a Discord server's structure over REST. */
export class DiscordGuildReader implements GuildReader {
    constructor(
        private readonly client: Client,
        private readonly timeoutMs = READ_TIMEOUT_MS
    ) {}

    read(guildId: string): Promise<ReadResult> {
        return guardedRead('Discord read', this.timeoutMs, async () => {
            if (!this.client.isReady()) {
                return {
                    ok: false,
                    reason: 'not-ready',
                    detail: 'Discord gateway is not ready',
                };
            }
            const guild = await this.client.guilds.fetch({
                guild: guildId,
                force: true,
            });
            if (!guild.available) {
                return {
                    ok: false,
                    reason: 'unavailable',
                    detail: `Discord guild ${guildId} is unavailable`,
                };
            }
            return snapshotOf(guild);
        });
    }

    isGone(
        guildId: string,
        kind: SyncKind,
        id: string
    ): Promise<boolean | null> {
        return guardedLookup(
            this.timeoutMs,
            async () => {
                const guild = await this.client.guilds.fetch({
                    guild: guildId,
                    force: true,
                });
                return this.fetchOne(guild, kind, id);
            },
            isUnknown
        );
    }

    private fetchOne(
        guild: Guild,
        kind: SyncKind,
        id: string
    ): Promise<unknown> {
        const force = { force: true };
        switch (kind) {
            case 'role':
                return guild.roles.fetch(id, force);
            case 'category':
            case 'channel':
            case 'thread':
                return guild.channels.fetch(id, force);
            case 'emoji':
                return guild.emojis.fetch(id, force);
            case 'sticker':
                return guild.stickers.fetch(id, force);
            case 'guild':
                return Promise.resolve(guild);
        }
    }
}

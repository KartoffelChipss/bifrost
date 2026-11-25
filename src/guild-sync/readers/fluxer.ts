import type {
    Client,
    Guild,
    GuildChannel,
    GuildEmoji,
    GuildSticker,
    Role,
    ThreadChannel,
} from '@fluxerjs/core';
import type { ReadResult } from '../health';
import type { SyncKind } from '../ops';
import type {
    ChannelSnap,
    EmojiSnap,
    ForumSnap,
    GuildSettingsSnap,
    GuildSnapshot,
    OverwriteSnap,
    RoleSnap,
    StickerSnap,
    ThreadSnap,
} from '../snapshot';
import {
    SYNCED_THREAD_TYPES,
    THREAD_ONLY_TYPES,
    THREAD_PARENT_TYPES,
} from '../snapshot';
import {
    READ_TIMEOUT_MS,
    guardedLookup,
    guardedRead,
    type GuildReader,
} from './reader';

/** Fluxer answers 404 for an unknown channel, role, emoji or sticker. */
function isUnknown(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    return (error as { statusCode?: unknown }).statusCode === 404;
}

interface FluxerTag {
    readonly id: string;
    readonly name: string;
    readonly moderated?: boolean;
    readonly emoji_id?: string | null;
    readonly emoji_name?: string | null;
}

/** Fields only some channel classes have. */
interface OptionalChannelFields {
    readonly topic?: string | null;
    readonly nsfw?: boolean;
    readonly rateLimitPerUser?: number;
    readonly bitrate?: number | null;
    readonly userLimit?: number | null;
    readonly availableTags?: readonly FluxerTag[];
    readonly defaultAutoArchiveDuration?: number | null;
    readonly defaultThreadRateLimitPerUser?: number | null;
    readonly defaultReactionEmoji?: {
        emoji_id: string | null;
        emoji_name: string | null;
    } | null;
    readonly defaultSortOrder?: number | null;
    readonly defaultForumLayout?: number | null;
    readonly threads?: {
        fetchArchived(options: {
            type: 'public' | 'private';
            limit: number;
            before?: string;
        }): Promise<{ threads: ThreadChannel[]; hasMore: boolean }>;
    };
}

const PRIVATE_THREAD = 12;
/** The forum-post pinned flag, the same bit on both platforms. */
const PINNED_FLAG = 1 << 1;

function forumOf(extra: OptionalChannelFields): ForumSnap {
    const reaction = extra.defaultReactionEmoji;
    return {
        defaultReaction: reaction
            ? { emojiId: reaction.emoji_id, emojiName: reaction.emoji_name }
            : null,
        sortOrder: extra.defaultSortOrder ?? null,
        layout: extra.defaultForumLayout ?? null,
        tags: (extra.availableTags ?? []).map((tag) => ({
            name: tag.name,
            moderated: tag.moderated ?? false,
            emojiId: tag.emoji_id ?? null,
            emojiName: tag.emoji_name ?? null,
        })),
    };
}

/** Thread defaults, for the channel kinds that hold threads. */
function threadDefaults(type: number, extra: OptionalChannelFields) {
    if (!THREAD_PARENT_TYPES.has(type)) return {};
    return {
        defaultAutoArchive: extra.defaultAutoArchiveDuration ?? null,
        defaultThreadSlowmode: extra.defaultThreadRateLimitPerUser ?? null,
    };
}

export function fluxerChannel(c: GuildChannel): ChannelSnap {
    const extra = c as GuildChannel & OptionalChannelFields;
    const overwrites: OverwriteSnap[] = [];
    for (const o of c.permissionOverwrites) {
        overwrites.push({
            id: o.id,
            type: Number(o.type) === 1 ? 1 : 0,
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString(),
        });
    }
    return {
        id: c.id,
        type: Number(c.type),
        name: c.name ?? '',
        position: c.position ?? 0,
        parentId: c.parentId,
        topic: extra.topic ?? null,
        nsfw: extra.nsfw ?? false,
        rateLimitPerUser: extra.rateLimitPerUser ?? 0,
        bitrate: extra.bitrate ?? null,
        userLimit: extra.userLimit ?? null,
        overwrites,
        tags: (extra.availableTags ?? []).map((tag) => tag.name),
        ...threadDefaults(Number(c.type), extra),
        ...(THREAD_ONLY_TYPES.has(Number(c.type))
            ? { forum: forumOf(extra) }
            : {}),
    };
}

/**
 * Archived threads are read 100 at a time, up to this many pages a channel.
 * A channel with more is reported as a gap rather than cut off silently.
 */
const MAX_ARCHIVE_PAGES = 20;

function fluxerThread(
    t: ThreadChannel,
    tagNames: ReadonlyMap<string, string>
): ThreadSnap {
    const tags: string[] = [];
    for (const id of t.appliedTags) {
        const name = tagNames.get(id);
        if (name !== undefined) tags.push(name);
    }
    const isPrivate = Number(t.type) === PRIVATE_THREAD;
    return {
        id: t.id,
        parentId: t.parentId ?? '',
        name: t.name ?? '',
        archived: t.archived,
        locked: t.locked,
        tags: tags.sort(),
        private: isPrivate,
        ...(isPrivate ? { invitable: t.invitable ?? true } : {}),
        pinned: (t.flags & PINNED_FLAG) !== 0,
        rateLimitPerUser: t.rateLimitPerUser ?? 0,
        autoArchiveDuration: t.autoArchiveDuration,
    };
}

/**
 * Archived private threads, paged like public ones. A refusal or a list
 * longer than MAX_ARCHIVE_PAGES is reported, not thrown.
 */
async function archivedPrivate(
    parent: GuildChannel
): Promise<{ threads: ThreadChannel[]; readable: boolean }> {
    const manager = (parent as GuildChannel & OptionalChannelFields).threads;
    if (!manager || THREAD_ONLY_TYPES.has(Number(parent.type))) {
        return { threads: [], readable: true };
    }
    try {
        const result = await archivedThreads(parent, 'private');
        return { threads: result.threads, readable: result.complete };
    } catch {
        return { threads: [], readable: false };
    }
}

/** `complete` is false when more pages remain after MAX_ARCHIVE_PAGES. */
async function archivedThreads(
    parent: GuildChannel,
    type: 'public' | 'private' = 'public'
): Promise<{ threads: ThreadChannel[]; complete: boolean }> {
    const manager = (parent as GuildChannel & OptionalChannelFields).threads;
    if (!manager) return { threads: [], complete: true };
    const found: ThreadChannel[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_ARCHIVE_PAGES; page++) {
        const result = await manager.fetchArchived({
            type,
            limit: 100,
            before,
        });
        found.push(...result.threads);
        const last = result.threads[result.threads.length - 1];
        before = last?.archiveTimestamp ?? undefined;
        if (!result.hasMore || !before) {
            return { threads: found, complete: true };
        }
    }
    return { threads: found, complete: false };
}

/** Lists active and archived threads. An unreadable archive is a gap. */
async function readThreads(
    guild: Guild,
    channels: readonly GuildChannel[]
): Promise<{ threads: ThreadSnap[]; gaps: string[]; privateGaps: string[] }> {
    const tagNames = new Map<string, string>();
    for (const channel of channels) {
        const tags = (channel as GuildChannel & OptionalChannelFields)
            .availableTags;
        for (const tag of tags ?? []) tagNames.set(tag.id, tag.name);
    }
    const all = new Map<string, ThreadChannel>();
    const active = await guild.fetchActiveThreads();
    for (const thread of active.threads) all.set(thread.id, thread);
    const gaps: string[] = [];
    const privateGaps: string[] = [];
    for (const parent of channels) {
        if (!THREAD_PARENT_TYPES.has(Number(parent.type))) continue;
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
        .filter((t) => SYNCED_THREAD_TYPES.has(Number(t.type)) && t.parentId)
        .map((t) => fluxerThread(t, tagNames));
    return { threads, gaps, privateGaps };
}

export function fluxerRole(r: Role): RoleSnap {
    return {
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: r.permissions.bitfield.toString(),
        position: r.position,
        // Fluxer has no managed roles.
        managed: false,
        unicodeEmoji: r.unicodeEmoji ?? null,
    };
}

function settingsOf(guild: Guild): GuildSettingsSnap {
    return {
        systemChannelId: guild.systemChannelId,
        afkChannelId: guild.afkChannelId,
        afkTimeout: guild.afkTimeout,
        verificationLevel: Number(guild.verificationLevel),
        defaultNotifications: Number(guild.defaultMessageNotifications),
        explicitContentFilter: Number(guild.explicitContentFilter),
    };
}

const fluxerEmoji = (e: GuildEmoji): EmojiSnap => ({
    id: e.id,
    name: e.name,
    animated: e.animated,
});

const fluxerSticker = (s: GuildSticker): StickerSnap => ({
    id: s.id,
    name: s.name,
    description: s.description,
    tags: s.tags.join(','),
});

async function snapshotOf(guild: Guild): Promise<GuildSnapshot> {
    const [channels, roles, emojis, stickers, me] = await Promise.all([
        guild.fetchChannels(),
        guild.fetchRoles(),
        guild.fetchEmojis(),
        guild.fetchStickers(),
        guild.fetchMe(),
    ]);
    const { threads, gaps, privateGaps } = await readThreads(guild, channels);
    return {
        side: 'fluxer',
        guildId: guild.id,
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner,
        everyoneRoleId: guild.id,
        roles: roles.map(fluxerRole),
        channels: channels.map(fluxerChannel),
        emojis: emojis.map(fluxerEmoji),
        stickers: stickers.map(fluxerSticker),
        threads,
        threadGaps: gaps,
        privateThreadGaps: privateGaps,
        settings: settingsOf(guild),
        features: [...(guild.features ?? [])],
        bot: {
            userId: me.id,
            roleIds: [...me.roles.roleIds],
            isOwner: guild.ownerId === me.id,
        },
    };
}

/** Reads a Fluxer server's structure over REST. */
export class FluxerGuildReader implements GuildReader {
    /** Takes the client ref, because upstream replaces the client on restart. */
    constructor(
        private readonly clientRef: { readonly current: Client | null },
        private readonly timeoutMs = READ_TIMEOUT_MS
    ) {}

    read(guildId: string): Promise<ReadResult> {
        return guardedRead('Fluxer read', this.timeoutMs, async () => {
            const client = this.clientRef.current;
            if (!client?.isReady()) {
                return {
                    ok: false,
                    reason: 'not-ready',
                    detail: 'Fluxer gateway is not ready',
                };
            }
            const guild = await client.guilds.fetch(guildId, { force: true });
            if (!guild.available) {
                return {
                    ok: false,
                    reason: 'unavailable',
                    detail: `Fluxer guild ${guildId} is unavailable`,
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
        const client = this.clientRef.current;
        if (!client?.isReady()) return Promise.resolve(null);
        return guardedLookup(
            this.timeoutMs,
            async () => {
                const guild = await client.guilds.fetch(guildId, {
                    force: true,
                });
                return fetchOne(guild, kind, id);
            },
            isUnknown
        );
    }
}

function fetchOne(guild: Guild, kind: SyncKind, id: string): Promise<unknown> {
    switch (kind) {
        case 'role':
            return guild.fetchRole(id);
        case 'category':
        case 'channel':
        case 'thread':
            return guild.client.channels.fetch(id, { force: true });
        case 'emoji':
            return guild.fetchEmoji(id);
        case 'sticker':
            return guild.fetchSticker(id);
        case 'guild':
            return Promise.resolve(guild);
    }
}

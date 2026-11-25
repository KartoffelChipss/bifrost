import type { SyncDirection } from '../addons/db/schema';
import type { IdMap } from './idmap';
import type { JsonValue } from './ops';
import { MANAGED_BITS, translatePermissions } from './permissions';
import type {
    ChannelSnap,
    EmojiRef,
    EmojiSnap,
    GuildSettingsSnap,
    OverwriteSnap,
    RoleSnap,
    StickerSnap,
    ThreadSnap,
} from './snapshot';
import { channelKind } from './snapshot';

/**
 * Projections put both sides into destination terms, so the diff compares
 * like with like: source IDs become mapped destination IDs, source
 * permissions become translated managed bits, and destination permissions
 * keep only managed bits. A field that cannot be compared yet, such as a
 * parent category that is not created, is left out of both sides.
 */

export type Fields = Readonly<Record<string, JsonValue>>;

export interface ProjectionContext {
    readonly map: IdMap;
    readonly direction: SyncDirection;
    /**
     * Linked accounts, source user ID to destination user ID (identity
     * add-on). A member overwrite is synced only for a linked member.
     */
    readonly members?: ReadonlyMap<string, string>;
}

/** Destination user IDs whose member overwrites the sync manages. */
export function managedMembers(ctx: ProjectionContext): ReadonlySet<string> {
    return new Set(ctx.members?.values() ?? []);
}

const managed = (bits: string) => (BigInt(bits) & MANAGED_BITS).toString();

function translated(bits: string, direction: SyncDirection): string {
    return translatePermissions(BigInt(bits), direction).bits.toString();
}

/** Role fields both sides compare as they are. */
function roleLook(role: RoleSnap): Record<string, JsonValue> {
    const fields: Record<string, JsonValue> = {
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
    };
    if (role.unicodeEmoji !== undefined) {
        fields.unicodeEmoji = role.unicodeEmoji;
    }
    return fields;
}

export function projectSourceRole(role: RoleSnap, ctx: ProjectionContext) {
    const fields: Record<string, JsonValue> = {
        permissions: translated(role.permissions, ctx.direction),
    };
    if (role.id === ctx.map.sourceEveryone) return fields;
    return { ...fields, ...roleLook(role) };
}

export function projectDestRole(role: RoleSnap, ctx: ProjectionContext) {
    const fields: Record<string, JsonValue> = {
        permissions: managed(role.permissions),
    };
    if (role.id === ctx.map.destEveryone) return fields;
    return { ...fields, ...roleLook(role) };
}

/**
 * Fields compared only with the last write, never with the destination:
 * a role's image icon is a platform-specific hash.
 */
export function projectOpaqueRole(role: RoleSnap): Fields {
    return role.icon === undefined ? {} : { icon: role.icon };
}

function sortOverwrites(list: Record<string, string>[]): JsonValue {
    return list.sort((a, b) => a.id.localeCompare(b.id));
}

/** A member overwrite carries `type: '1'`; a role overwrite has no type. */
const MEMBER_TYPE = '1';

function sourceOverwrites(
    overwrites: readonly OverwriteSnap[],
    ctx: ProjectionContext
): JsonValue {
    const list: Record<string, string>[] = [];
    for (const overwrite of overwrites) {
        const destId =
            overwrite.type === 0
                ? ctx.map.dest('role', overwrite.id)
                : (ctx.members?.get(overwrite.id) ?? null);
        if (!destId) continue;
        list.push({
            id: destId,
            ...(overwrite.type === 1 ? { type: MEMBER_TYPE } : {}),
            allow: translated(overwrite.allow, ctx.direction),
            deny: translated(overwrite.deny, ctx.direction),
        });
    }
    return sortOverwrites(list);
}

function destOverwrites(
    overwrites: readonly OverwriteSnap[],
    ctx: ProjectionContext
): JsonValue {
    const members = managedMembers(ctx);
    const list: Record<string, string>[] = [];
    for (const overwrite of overwrites) {
        const isManaged =
            overwrite.type === 0
                ? ctx.map.managesDestRole(overwrite.id)
                : members.has(overwrite.id);
        if (!isManaged) continue;
        list.push({
            id: overwrite.id,
            ...(overwrite.type === 1 ? { type: MEMBER_TYPE } : {}),
            allow: managed(overwrite.allow),
            deny: managed(overwrite.deny),
        });
    }
    return sortOverwrites(list);
}

/** An emoji in destination terms, or undefined for an unmapped custom one. */
type EmojiProjection = (ref: EmojiRef) => JsonValue | undefined;

const byName = (ref: EmojiRef): JsonValue =>
    ref.emojiName ? { name: ref.emojiName } : null;

function sourceEmoji(ctx: ProjectionContext): EmojiProjection {
    return (ref) => {
        if (!ref.emojiId) return byName(ref);
        const id = ctx.map.dest('emoji', ref.emojiId);
        return id ? { id } : undefined;
    };
}

const destEmoji: EmojiProjection = (ref) =>
    ref.emojiId ? { id: ref.emojiId } : byName(ref);

/** Defaults new threads get, and a forum's own settings. */
function threadParentFields(
    channel: ChannelSnap,
    emoji: EmojiProjection
): Record<string, JsonValue> {
    const fields: Record<string, JsonValue> = {};
    if (channel.defaultAutoArchive !== undefined) {
        fields.defaultAutoArchive = channel.defaultAutoArchive;
    }
    if (channel.defaultThreadSlowmode !== undefined) {
        fields.defaultThreadSlowmode = channel.defaultThreadSlowmode;
    }
    const forum = channel.forum;
    if (!forum) return fields;
    const reaction = forum.defaultReaction
        ? emoji(forum.defaultReaction)
        : null;
    if (reaction !== undefined) fields.defaultReaction = reaction;
    fields.sortOrder = forum.sortOrder;
    fields.layout = forum.layout;
    fields.tagMeta = forum.tags.map((tag) => ({
        name: tag.name,
        moderated: tag.moderated,
        emoji: emoji(tag) ?? null,
    }));
    return fields;
}

function kindFields(
    channel: ChannelSnap,
    emoji: EmojiProjection
): Record<string, JsonValue> {
    const kind = channelKind(channel.type);
    if (kind === 'category') return {};
    if (kind === 'voice') {
        return {
            nsfw: channel.nsfw,
            bitrate: channel.bitrate,
            userLimit: channel.userLimit,
        };
    }
    const fields: Record<string, JsonValue> = {
        nsfw: channel.nsfw,
        topic: channel.topic,
        rateLimitPerUser: channel.rateLimitPerUser,
    };
    if (kind === 'forum') fields.tags = [...channel.tags];
    return { ...fields, ...threadParentFields(channel, emoji) };
}

export function projectSourceChannel(
    channel: ChannelSnap,
    ctx: ProjectionContext
): Fields {
    const fields: Record<string, JsonValue> = {
        name: channel.name,
        ...kindFields(channel, sourceEmoji(ctx)),
        overwrites: sourceOverwrites(channel.overwrites, ctx),
    };
    if (channel.parentId === null) fields.parentId = null;
    else {
        const parent = ctx.map.dest('category', channel.parentId);
        if (parent) fields.parentId = parent;
    }
    return fields;
}

export function projectDestChannel(
    channel: ChannelSnap,
    ctx: ProjectionContext
): Fields {
    return {
        name: channel.name,
        ...kindFields(channel, destEmoji),
        overwrites: destOverwrites(channel.overwrites, ctx),
        parentId: channel.parentId,
    };
}

export function projectEmoji(emoji: EmojiSnap): Fields {
    return { name: emoji.name };
}

export function projectSticker(sticker: StickerSnap): Fields {
    return {
        name: sticker.name,
        description: sticker.description,
        tags: sticker.tags,
    };
}

/** Thread fields both sides compare as they are. */
function threadLook(thread: ThreadSnap): Record<string, JsonValue> {
    const fields: Record<string, JsonValue> = {
        name: thread.name,
        archived: thread.archived,
        locked: thread.locked,
        tags: [...thread.tags],
    };
    const optional = {
        private: thread.private,
        invitable: thread.invitable,
        pinned: thread.pinned,
        rateLimitPerUser: thread.rateLimitPerUser,
        autoArchiveDuration: thread.autoArchiveDuration,
    };
    for (const [field, value] of Object.entries(optional)) {
        if (value !== undefined) fields[field] = value;
    }
    return fields;
}

/** A thread or forum post. The parent is given as a destination ID. */
export function projectSourceThread(
    thread: ThreadSnap,
    ctx: ProjectionContext
): Fields {
    const fields = threadLook(thread);
    const parent = ctx.map.dest('channel', thread.parentId);
    if (parent) fields.parentId = parent;
    return fields;
}

export function projectDestThread(thread: ThreadSnap): Fields {
    return { ...threadLook(thread), parentId: thread.parentId };
}

/** Discord's highest verification level has no Fluxer counterpart. */
const MAX_VERIFICATION = 3;

/** Server settings in destination terms. A channel not mapped yet is left out. */
export function projectSourceSettings(
    settings: GuildSettingsSnap | undefined,
    ctx: ProjectionContext
): Fields {
    if (!settings) return {};
    const fields: Record<string, JsonValue> = {
        afkTimeout: settings.afkTimeout,
        verificationLevel: Math.min(
            settings.verificationLevel,
            MAX_VERIFICATION
        ),
        defaultNotifications: settings.defaultNotifications,
        explicitContentFilter: settings.explicitContentFilter,
    };
    for (const field of ['systemChannelId', 'afkChannelId'] as const) {
        const id = settings[field];
        if (id === null) fields[field] = null;
        else {
            const dest = ctx.map.dest('channel', id);
            if (dest) fields[field] = dest;
        }
    }
    return fields;
}

export function projectDestSettings(
    settings: GuildSettingsSnap | undefined
): Fields {
    return settings ? { ...settings } : {};
}

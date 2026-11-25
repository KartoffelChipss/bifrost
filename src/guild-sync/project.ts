import type { SyncDirection } from '../addons/db/schema';
import type { IdMap } from './idmap';
import type { JsonValue } from './ops';
import { MANAGED_BITS, translatePermissions } from './permissions';
import type {
    ChannelSnap,
    EmojiSnap,
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
}

const managed = (bits: string) => (BigInt(bits) & MANAGED_BITS).toString();

function translated(bits: string, direction: SyncDirection): string {
    return translatePermissions(BigInt(bits), direction).bits.toString();
}

export function projectSourceRole(role: RoleSnap, ctx: ProjectionContext) {
    const fields: Record<string, JsonValue> = {
        permissions: translated(role.permissions, ctx.direction),
    };
    if (role.id === ctx.map.sourceEveryone) return fields;
    return {
        ...fields,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
    };
}

export function projectDestRole(role: RoleSnap, ctx: ProjectionContext) {
    const fields: Record<string, JsonValue> = {
        permissions: managed(role.permissions),
    };
    if (role.id === ctx.map.destEveryone) return fields;
    return {
        ...fields,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
    };
}

function sortOverwrites(list: Record<string, string>[]): JsonValue {
    return list.sort((a, b) => a.id.localeCompare(b.id));
}

function sourceOverwrites(
    overwrites: readonly OverwriteSnap[],
    ctx: ProjectionContext
): JsonValue {
    const list: Record<string, string>[] = [];
    for (const overwrite of overwrites) {
        if (overwrite.type !== 0) continue;
        const destId = ctx.map.dest('role', overwrite.id);
        if (!destId) continue;
        list.push({
            id: destId,
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
    const list: Record<string, string>[] = [];
    for (const overwrite of overwrites) {
        if (overwrite.type !== 0) continue;
        if (!ctx.map.managesDestRole(overwrite.id)) continue;
        list.push({
            id: overwrite.id,
            allow: managed(overwrite.allow),
            deny: managed(overwrite.deny),
        });
    }
    return sortOverwrites(list);
}

function kindFields(channel: ChannelSnap): Record<string, JsonValue> {
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
    return fields;
}

export function projectSourceChannel(
    channel: ChannelSnap,
    ctx: ProjectionContext
): Fields {
    const fields: Record<string, JsonValue> = {
        name: channel.name,
        ...kindFields(channel),
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
        ...kindFields(channel),
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

/** A thread or forum post. The parent is given as a destination ID. */
export function projectSourceThread(
    thread: ThreadSnap,
    ctx: ProjectionContext
): Fields {
    const fields: Record<string, JsonValue> = {
        name: thread.name,
        archived: thread.archived,
        locked: thread.locked,
        tags: [...thread.tags],
    };
    const parent = ctx.map.dest('channel', thread.parentId);
    if (parent) fields.parentId = parent;
    return fields;
}

export function projectDestThread(thread: ThreadSnap): Fields {
    return {
        name: thread.name,
        archived: thread.archived,
        locked: thread.locked,
        tags: [...thread.tags],
        parentId: thread.parentId,
    };
}

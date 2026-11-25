import type { SyncDirection } from '../addons/db/schema';
import type { IdMap } from './idmap';
import type { FieldChange, JsonValue, PlanOp } from './ops';
import { bitOf, mergePermissions, NO_BITS } from './permissions';
import {
    projectEmoji,
    projectSourceChannel,
    projectSourceRole,
    projectSourceThread,
    projectSticker,
    type Fields,
    type ProjectionContext,
} from './project';
import type { ChannelSnap, GuildSnapshot } from './snapshot';
import { channelKind } from './snapshot';
import type {
    ChannelPatch,
    ChannelSpec,
    OverwriteSpec,
    PositionSpec,
    RolePatch,
    RoleSpec,
    StickerPatch,
    ThreadPatch,
} from './writers/writer';

/**
 * Turns one plan op into the write it needs, in destination terms. Pure: no
 * network, no database. The executor (apply.ts) performs the write.
 */

export interface WriteContext {
    readonly source: GuildSnapshot;
    readonly destination: GuildSnapshot;
    /** The live map: it already holds objects created earlier in the plan. */
    readonly map: IdMap;
    readonly direction: SyncDirection;
}

/**
 * `applied` is the source's projected fields at write time. It becomes the
 * base the next diff compares the source against.
 */
export type WriteAction =
    | { readonly type: 'create-role'; spec: RoleSpec; applied: Fields }
    | { readonly type: 'create-channel'; spec: ChannelSpec; applied: Fields }
    | { readonly type: 'update-role'; patch: RolePatch; applied: Fields }
    | { readonly type: 'update-channel'; patch: ChannelPatch; applied: Fields }
    | { readonly type: 'rename-guild'; name: string; applied: Fields }
    | { readonly type: 'role-positions'; positions: PositionSpec[] }
    | { readonly type: 'channel-positions'; positions: PositionSpec[] }
    | { readonly type: 'create-emoji'; name: string; applied: Fields }
    | { readonly type: 'rename-emoji'; name: string; applied: Fields }
    | {
          readonly type: 'create-sticker';
          name: string;
          description: string;
          tags: string[];
          applied: Fields;
      }
    | { readonly type: 'update-sticker'; patch: StickerPatch; applied: Fields }
    | { readonly type: 'archive-role'; patch: RolePatch }
    | {
          readonly type: 'archive-channel';
          patch: ChannelPatch;
          /** True for a channel, which also moves to the archive category. */
          move: boolean;
      }
    | { readonly type: 'archive-emoji'; name: string }
    | { readonly type: 'archive-sticker'; name: string }
    | { readonly type: 'delete' }
    | { readonly type: 'link' }
    | {
          readonly type: 'create-thread';
          parentId: string;
          parentSourceId: string;
          parentType: number;
          name: string;
          tags: string[];
          archived: boolean;
          locked: boolean;
          applied: Fields;
      }
    | { readonly type: 'update-thread'; patch: ThreadPatch; applied: Fields }
    | { readonly type: 'archive-thread'; patch: ThreadPatch }
    | { readonly type: 'skip'; reason: string };

/** The locked category archived channels move to (guard 5). */
export const ARCHIVE_CATEGORY = 'archived-sync';

/**
 * Denied to @everyone on an archived channel, so it stays readable only:
 * SendMessages, Connect and SendMessagesInThreads.
 */
export const LOCK_BITS = bitOf(11) | bitOf(20) | bitOf(38);

const ROLE_NAME_MAX = 100;
const EMOJI_NAME_MAX = 32;
const STICKER_NAME_MAX = 30;

const archivedName = (name: string, max: number) =>
    `[archived] ${name}`.slice(0, max);
const archivedExpression = (name: string, max: number) =>
    `archived_${name}`.slice(0, max);

/** Adds the lock to @everyone and leaves every other overwrite as it is. */
export function lockOverwrites(
    existing: ChannelSnap['overwrites'],
    everyoneId: string
): OverwriteSpec[] {
    const others = existing.filter(
        (o) => !(o.type === 0 && o.id === everyoneId)
    );
    const everyone = existing.find((o) => o.type === 0 && o.id === everyoneId);
    return [
        ...others,
        {
            id: everyoneId,
            type: 0,
            allow: (BigInt(everyone?.allow ?? '0') & ~LOCK_BITS).toString(),
            deny: (BigInt(everyone?.deny ?? '0') | LOCK_BITS).toString(),
        },
    ];
}

const skip = (reason: string): WriteAction => ({ type: 'skip', reason });

const text = (value: JsonValue | undefined, fallback: string): string =>
    typeof value === 'string' ? value : fallback;
const flag = (value: JsonValue | undefined): boolean => value === true;
const count = (value: JsonValue | undefined): number | null =>
    typeof value === 'number' ? value : null;
const names = (value: JsonValue | undefined): string[] =>
    Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];

interface ManagedOverwrite {
    readonly id: string;
    readonly allow: string;
    readonly deny: string;
}

function managedOverwrites(value: JsonValue | undefined): ManagedOverwrite[] {
    if (!Array.isArray(value)) return [];
    const list: ManagedOverwrite[] = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            continue;
        const { id, allow, deny } = item as Record<string, JsonValue>;
        if (
            typeof id === 'string' &&
            typeof allow === 'string' &&
            typeof deny === 'string'
        ) {
            list.push({ id, allow, deny });
        }
    }
    return list;
}

const merged = (existing: string | undefined, managed: string): string =>
    mergePermissions(BigInt(existing ?? '0'), BigInt(managed)).toString();

/**
 * The complete overwrite list for a channel: overwrites the sync does not
 * manage stay as they are, and managed ones keep their unmanaged bits.
 */
export function mergeOverwrites(
    desired: readonly ManagedOverwrite[],
    existing: ChannelSnap['overwrites'],
    map: IdMap
): OverwriteSpec[] {
    const kept: OverwriteSpec[] = existing.filter(
        (o) => o.type === 1 || !map.managesDestRole(o.id)
    );
    const managed: OverwriteSpec[] = desired.map((want) => {
        const have = existing.find((o) => o.type === 0 && o.id === want.id);
        return {
            id: want.id,
            type: 0,
            allow: merged(have?.allow, want.allow),
            deny: merged(have?.deny, want.deny),
        };
    });
    return [...kept, ...managed];
}

function roleSpec(fields: Fields): RoleSpec {
    return {
        name: text(fields.name, ''),
        color: count(fields.color) ?? 0,
        hoist: flag(fields.hoist),
        mentionable: flag(fields.mentionable),
        permissions: text(fields.permissions, '0'),
    };
}

function channelSpec(
    channel: ChannelSnap,
    fields: Fields,
    map: IdMap
): ChannelSpec {
    return {
        type: channel.type,
        name: text(fields.name, channel.name),
        parentId: typeof fields.parentId === 'string' ? fields.parentId : null,
        topic: typeof fields.topic === 'string' ? fields.topic : null,
        nsfw: flag(fields.nsfw),
        rateLimitPerUser: count(fields.rateLimitPerUser) ?? 0,
        bitrate: count(fields.bitrate),
        userLimit: count(fields.userLimit),
        overwrites: mergeOverwrites(
            managedOverwrites(fields.overwrites),
            [],
            map
        ),
        tags: names(fields.tags),
    };
}

type CreateOp = Extract<PlanOp, { op: 'create' }>;
type UpdateOp = Extract<PlanOp, { op: 'update' }>;
type ReorderOp = Extract<PlanOp, { op: 'reorder' }>;
type ArchiveOp = Extract<PlanOp, { op: 'archive' }>;

function createAction(op: CreateOp, ctx: WriteContext): WriteAction {
    if (op.existingDestId) {
        return skip(
            `a destination ${op.kind} named "${op.name}" already exists; adopting it is not built yet`
        );
    }
    const projection: ProjectionContext = ctx;
    if (op.kind === 'role') {
        const role = ctx.source.roles.find((r) => r.id === op.sourceId);
        if (!role) return skip('the source role is gone');
        const applied = projectSourceRole(role, projection);
        return { type: 'create-role', spec: roleSpec(applied), applied };
    }
    if (op.kind === 'category' || op.kind === 'channel') {
        const channel = ctx.source.channels.find((c) => c.id === op.sourceId);
        if (!channel) return skip('the source channel is gone');
        const applied = projectSourceChannel(channel, projection);
        return {
            type: 'create-channel',
            spec: channelSpec(channel, applied, ctx.map),
            applied,
        };
    }
    if (op.kind === 'emoji') {
        const emoji = ctx.source.emojis.find((e) => e.id === op.sourceId);
        if (!emoji) return skip('the source emoji is gone');
        return {
            type: 'create-emoji',
            name: emoji.name,
            applied: projectEmoji(emoji),
        };
    }
    if (op.kind === 'sticker') {
        const sticker = ctx.source.stickers.find((s) => s.id === op.sourceId);
        if (!sticker) return skip('the source sticker is gone');
        return {
            type: 'create-sticker',
            name: sticker.name,
            description: sticker.description,
            tags: sticker.tags.split(',').filter((tag) => tag !== ''),
            applied: projectSticker(sticker),
        };
    }
    if (op.kind === 'thread') return createThread(op, ctx);
    return skip(`a ${op.kind} cannot be created`);
}

function rolePatch(
    changes: readonly FieldChange[],
    current: string
): RolePatch {
    const patch: Record<string, JsonValue> = {};
    for (const change of changes) {
        patch[change.field] =
            change.field === 'permissions'
                ? merged(current, text(change.to, '0'))
                : change.to;
    }
    return patch as RolePatch;
}

function channelPatch(
    changes: readonly FieldChange[],
    dest: ChannelSnap,
    map: IdMap
): ChannelPatch {
    const patch: Record<string, unknown> = {};
    for (const change of changes) {
        if (change.field === 'overwrites') {
            patch.overwrites = mergeOverwrites(
                managedOverwrites(change.to),
                dest.overwrites,
                map
            );
        } else if (change.field === 'tags') patch.tags = names(change.to);
        else patch[change.field] = change.to;
    }
    return patch as ChannelPatch;
}

/** A thread patch from the changed fields. The parent never changes. */
function threadPatch(changes: readonly FieldChange[]): ThreadPatch {
    const patch: {
        name?: string;
        archived?: boolean;
        locked?: boolean;
        tags?: string[];
    } = {};
    for (const { field, to } of changes) {
        if (field === 'name' && typeof to === 'string') patch.name = to;
        else if (field === 'archived') patch.archived = to === true;
        else if (field === 'locked') patch.locked = to === true;
        else if (field === 'tags') patch.tags = names(to);
    }
    return patch;
}

function createThread(op: CreateOp, ctx: WriteContext): WriteAction {
    const thread = ctx.source.threads.find((t) => t.id === op.sourceId);
    if (!thread) return skip('the source thread is gone');
    const parentId = ctx.map.dest('channel', thread.parentId);
    const parent = ctx.source.channels.find((c) => c.id === thread.parentId);
    if (!parentId || !parent) {
        return skip('the parent channel is not created yet');
    }
    return {
        type: 'create-thread',
        parentId,
        parentSourceId: thread.parentId,
        parentType: parent.type,
        name: thread.name,
        tags: [...thread.tags],
        archived: thread.archived,
        locked: thread.locked,
        applied: projectSourceThread(thread, ctx),
    };
}

function updateAction(op: UpdateOp, ctx: WriteContext): WriteAction {
    const projection: ProjectionContext = ctx;
    if (op.kind === 'role') {
        const role = ctx.source.roles.find((r) => r.id === op.sourceId);
        const dest = ctx.destination.roles.find((r) => r.id === op.destId);
        if (!role || !dest) return skip('the role is gone on one side');
        return {
            type: 'update-role',
            patch: rolePatch(op.changes, dest.permissions),
            applied: projectSourceRole(role, projection),
        };
    }
    if (op.kind === 'category' || op.kind === 'channel') {
        const channel = ctx.source.channels.find((c) => c.id === op.sourceId);
        const dest = ctx.destination.channels.find((c) => c.id === op.destId);
        if (!channel || !dest) return skip('the channel is gone on one side');
        return {
            type: 'update-channel',
            patch: channelPatch(op.changes, dest, ctx.map),
            applied: projectSourceChannel(channel, projection),
        };
    }
    if (op.kind === 'guild') {
        const name = op.changes.find((c) => c.field === 'name')?.to;
        if (typeof name !== 'string') return skip('nothing to write');
        return { type: 'rename-guild', name, applied: { name } };
    }
    return expressionUpdate(op, ctx);
}

function expressionUpdate(op: UpdateOp, ctx: WriteContext): WriteAction {
    const changed = (field: string) =>
        op.changes.find((c) => c.field === field)?.to;
    if (op.kind === 'emoji') {
        const emoji = ctx.source.emojis.find((e) => e.id === op.sourceId);
        const name = changed('name');
        if (!emoji || typeof name !== 'string') return skip('nothing to write');
        return { type: 'rename-emoji', name, applied: projectEmoji(emoji) };
    }
    if (op.kind === 'sticker') {
        const sticker = ctx.source.stickers.find((s) => s.id === op.sourceId);
        if (!sticker) return skip('the source sticker is gone');
        const name = changed('name');
        const description = changed('description');
        const patch: StickerPatch = {
            ...(typeof name === 'string' ? { name } : {}),
            ...(typeof description === 'string' ? { description } : {}),
        };
        // Fluxer has no call that changes a sticker's tags.
        if (Object.keys(patch).length === 0) {
            return skip('sticker tags cannot be changed on the destination');
        }
        return {
            type: 'update-sticker',
            patch,
            applied: projectSticker(sticker),
        };
    }
    if (op.kind === 'thread') {
        const thread = ctx.source.threads.find((t) => t.id === op.sourceId);
        const patch = threadPatch(op.changes);
        if (!thread || Object.keys(patch).length === 0) {
            return skip('nothing to write');
        }
        return {
            type: 'update-thread',
            patch,
            applied: projectSourceThread(thread, ctx),
        };
    }
    return skip(`a ${op.kind} cannot be updated`);
}

/** Soft delete (guard 5): the object stays, renamed or locked. */
function archiveAction(op: ArchiveOp, ctx: WriteContext): WriteAction {
    const { destination } = ctx;
    if (op.kind === 'role') {
        const role = destination.roles.find((r) => r.id === op.destId);
        if (!role) return skip('the role is already gone');
        return {
            type: 'archive-role',
            patch: {
                name: archivedName(role.name, ROLE_NAME_MAX),
                permissions: NO_BITS.toString(),
            },
        };
    }
    if (op.kind === 'category' || op.kind === 'channel') {
        const channel = destination.channels.find((c) => c.id === op.destId);
        if (!channel) return skip('the channel is already gone');
        const overwrites = lockOverwrites(
            channel.overwrites,
            destination.everyoneRoleId
        );
        const isCategory = channelKind(channel.type) === 'category';
        return {
            type: 'archive-channel',
            move: !isCategory,
            patch: isCategory
                ? {
                      name: archivedName(channel.name, ROLE_NAME_MAX),
                      overwrites,
                  }
                : { overwrites },
        };
    }
    if (op.kind === 'emoji') {
        const emoji = destination.emojis.find((e) => e.id === op.destId);
        if (!emoji) return skip('the emoji is already gone');
        return {
            type: 'archive-emoji',
            name: archivedExpression(emoji.name, EMOJI_NAME_MAX),
        };
    }
    if (op.kind === 'sticker') {
        const sticker = destination.stickers.find((s) => s.id === op.destId);
        if (!sticker) return skip('the sticker is already gone');
        return {
            type: 'archive-sticker',
            name: archivedExpression(sticker.name, STICKER_NAME_MAX),
        };
    }
    if (op.kind === 'thread') {
        // An archived, locked thread stays readable and takes no posts.
        return {
            type: 'archive-thread',
            patch: { archived: true, locked: true },
        };
    }
    return skip('the server itself is never archived');
}

/**
 * Gives the listed objects their own position slots in the wanted order.
 * Objects outside the list keep their positions.
 */
export function positionsFor(
    destIds: readonly string[],
    current: ReadonlyMap<string, number>
): PositionSpec[] | null {
    const slots: number[] = [];
    for (const id of destIds) {
        const position = current.get(id);
        if (position === undefined) return null;
        slots.push(position);
    }
    slots.sort((a, b) => a - b);
    for (let i = 1; i < slots.length; i++) {
        // Equal slots cannot express an order, so spread them apart.
        if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
    }
    return destIds.map((id, i) => ({ id, position: slots[i] }));
}

function reorderAction(op: ReorderOp, ctx: WriteContext): WriteAction {
    const items =
        op.kind === 'role' ? ctx.destination.roles : ctx.destination.channels;
    const positions = positionsFor(
        op.destIds,
        new Map(items.map((item) => [item.id, item.position]))
    );
    if (!positions) return skip('an object in the order is gone');
    return op.kind === 'role'
        ? { type: 'role-positions', positions }
        : { type: 'channel-positions', positions };
}

/** The write one op needs, or the reason it cannot be applied. */
export function writeFor(op: PlanOp, ctx: WriteContext): WriteAction {
    switch (op.op) {
        case 'create':
            return createAction(op, ctx);
        case 'update':
            return updateAction(op, ctx);
        case 'reorder':
            return reorderAction(op, ctx);
        case 'link':
            return { type: 'link' };
        case 'archive':
            return archiveAction(op, ctx);
        case 'hard-delete':
            return op.kind === 'guild'
                ? skip('the server itself is never deleted')
                : { type: 'delete' };
    }
}

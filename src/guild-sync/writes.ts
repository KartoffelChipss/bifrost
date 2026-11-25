import type { SyncDirection } from '../addons/db/schema';
import type { IdMap } from './idmap';
import type { FieldChange, JsonValue, PlanOp } from './ops';
import { bitOf, mergePermissions, NO_BITS } from './permissions';
import {
    channelMapKind,
    managedMembers,
    projectEmoji,
    projectSourceChannel,
    projectSourceRole,
    projectSourceThread,
    projectSticker,
    type Fields,
    type ProjectionContext,
} from './project';
import type { ChannelSnap, GuildSnapshot } from './snapshot';
import { channelKind, copyType } from './snapshot';
import { layoutGroup } from './order';
import type {
    ChannelMove,
    ChannelPatch,
    ChannelSpec,
    EmojiChoice,
    GuildPatch,
    OverwriteSpec,
    PositionSpec,
    RolePatch,
    RoleSpec,
    StickerPatch,
    TagMetaSpec,
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
    /** Linked accounts, source user ID to destination user ID. */
    readonly members?: ReadonlyMap<string, string>;
    /** The source @everyone lacks View Channel (see ProjectionContext). */
    readonly hiddenFromEveryone?: boolean;
    /** The destination's voice bitrate cap (see ProjectionContext). */
    readonly maxBitrate?: number;
    /** Channels locked while their history imports (see ProjectionContext). */
    readonly historyLocked?: ReadonlySet<string>;
}

/**
 * `applied` is the source's projected fields at write time. It becomes the
 * base the next diff compares the source against.
 */
/**
 * A second write some creates need, sent after the map row is saved, so a
 * failure leaves an owned object to fix next cycle and never an orphan.
 * `fields` join `applied` only once the follow-up succeeded.
 */
export type FollowUp =
    | { readonly type: 'role'; patch: RolePatch; fields: Fields }
    | { readonly type: 'thread'; patch: ThreadPatch; fields: Fields };

export type WriteAction =
    | {
          readonly type: 'create-role';
          spec: RoleSpec;
          applied: Fields;
          followUp: FollowUp | null;
      }
    | { readonly type: 'create-channel'; spec: ChannelSpec; applied: Fields }
    | { readonly type: 'update-role'; patch: RolePatch; applied: Fields }
    | { readonly type: 'update-channel'; patch: ChannelPatch; applied: Fields }
    | { readonly type: 'update-guild'; patch: GuildPatch; applied: Fields }
    | { readonly type: 'role-positions'; positions: PositionSpec[] }
    | {
          readonly type: 'channel-positions';
          moves: ChannelMove[];
          /** The objects this write places; only their order flag clears. */
          placed: string[];
      }
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
    | { readonly type: 'archive-sticker'; patch: StickerPatch }
    | { readonly type: 'delete' }
    | { readonly type: 'link' }
    /** Records an object an earlier create made (adopt.ts). No write. */
    | { readonly type: 'adopt'; destId: string; applied: Fields }
    | {
          readonly type: 'create-thread';
          parentId: string;
          parentSourceId: string;
          parentType: number;
          name: string;
          tags: string[];
          private: boolean;
          invitable: boolean;
          applied: Fields;
          followUp: FollowUp | null;
      }
    | { readonly type: 'update-thread'; patch: ThreadPatch; applied: Fields }
    | { readonly type: 'archive-thread'; patch: ThreadPatch }
    /** The object is already gone from the destination: nothing to write. */
    | { readonly type: 'gone' }
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

const ARCHIVED_PREFIX = '[archived] ';
const ARCHIVED_EXPRESSION_PREFIX = 'archived_';

/** The archived name. A name archived before keeps its one prefix. */
export function archivedName(name: string, max: number): string {
    if (name.startsWith(ARCHIVED_PREFIX)) return name.slice(0, max);
    return `${ARCHIVED_PREFIX}${name}`.slice(0, max);
}

const archivedExpression = (name: string, max: number) =>
    name.startsWith(ARCHIVED_EXPRESSION_PREFIX)
        ? name.slice(0, max)
        : `${ARCHIVED_EXPRESSION_PREFIX}${name}`.slice(0, max);

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

/** A sticker's comma-separated tags as a list. */
const stickerTags = (tags: string): string[] =>
    tags.split(',').filter((tag) => tag !== '');

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
    readonly type: 0 | 1;
    readonly allow: string;
    readonly deny: string;
}

function managedOverwrites(value: JsonValue | undefined): ManagedOverwrite[] {
    if (!Array.isArray(value)) return [];
    const list: ManagedOverwrite[] = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            continue;
        const { id, type, allow, deny } = item as Record<string, JsonValue>;
        if (
            typeof id === 'string' &&
            typeof allow === 'string' &&
            typeof deny === 'string'
        ) {
            list.push({ id, type: type === '1' ? 1 : 0, allow, deny });
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
    map: IdMap,
    members: ReadonlySet<string> = new Set()
): OverwriteSpec[] {
    const kept: OverwriteSpec[] = existing.filter((o) =>
        o.type === 1 ? !members.has(o.id) : !map.managesDestRole(o.id)
    );
    const managed: OverwriteSpec[] = desired.map((want) => {
        const have = existing.find(
            (o) => o.type === want.type && o.id === want.id
        );
        return {
            id: want.id,
            type: want.type,
            allow: merged(have?.allow, want.allow),
            deny: merged(have?.deny, want.deny),
        };
    });
    return [...kept, ...managed];
}

/** Values Fluxer's role create cannot set, and what a new role has instead. */
const ROLE_CREATE_LATER: Readonly<Record<string, JsonValue>> = {
    hoist: false,
    mentionable: false,
    unicodeEmoji: null,
};

/**
 * Splits off what Fluxer's role create cannot set: hoist, mentionable and
 * the emoji icon. The base records what a new role has until the
 * follow-up sets the rest.
 */
function roleCreate(fields: Fields): WriteAction {
    const spec = roleSpec(fields);
    const applied: Record<string, JsonValue> = { ...fields };
    const later: Record<string, JsonValue> = {};
    for (const [field, start] of Object.entries(ROLE_CREATE_LATER)) {
        const want = fields[field];
        if (want === undefined || want === start) continue;
        later[field] = want;
        applied[field] = start;
    }
    if (Object.keys(later).length === 0) {
        return { type: 'create-role', spec, applied, followUp: null };
    }
    return {
        type: 'create-role',
        spec,
        applied,
        followUp: { type: 'role', patch: later as RolePatch, fields: later },
    };
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

function emojiChoice(value: JsonValue | undefined): EmojiChoice | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const { id, name } = value as Record<string, JsonValue>;
    if (typeof id === 'string') return { id };
    return typeof name === 'string' ? { name } : null;
}

function tagMeta(value: JsonValue | undefined): TagMetaSpec[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            return [];
        const tag = item as Record<string, JsonValue>;
        if (typeof tag.name !== 'string') return [];
        return [
            {
                name: tag.name,
                moderated: tag.moderated === true,
                emoji: emojiChoice(tag.emoji),
            },
        ];
    });
}

/** Thread defaults and forum settings, for the fields present. */
function parentSettings(fields: Fields): Partial<ChannelSpec> {
    const out: Record<string, unknown> = {};
    for (const field of [
        'defaultAutoArchive',
        'defaultThreadSlowmode',
        'sortOrder',
        'layout',
    ]) {
        if (field in fields) out[field] = count(fields[field]);
    }
    if ('defaultReaction' in fields) {
        out.defaultReaction = emojiChoice(fields.defaultReaction);
    }
    if ('tagMeta' in fields) out.tagMeta = tagMeta(fields.tagMeta);
    return out as Partial<ChannelSpec>;
}

function channelSpec(
    channel: ChannelSnap,
    fields: Fields,
    map: IdMap,
    members: ReadonlySet<string>
): ChannelSpec {
    return {
        ...parentSettings(fields),
        type: copyType(channel.type),
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
            map,
            members
        ),
        tags: names(fields.tags),
    };
}

type CreateOp = Extract<PlanOp, { op: 'create' }>;
type UpdateOp = Extract<PlanOp, { op: 'update' }>;
type ReorderOp = Extract<PlanOp, { op: 'reorder' }>;
type ArchiveOp = Extract<PlanOp, { op: 'archive' }>;

function createAction(op: CreateOp, ctx: WriteContext): WriteAction {
    // An empty base makes the next diff bring every field in line with
    // the source, whatever the earlier create left unfinished.
    if (op.existingDestId && op.adopt) {
        return { type: 'adopt', destId: op.existingDestId, applied: {} };
    }
    if (op.existingDestId) {
        return skip(
            `a destination ${op.kind} named "${op.name}" already exists; adopting it is not built yet`
        );
    }
    const projection: ProjectionContext = ctx;
    if (op.kind === 'role') {
        const role = ctx.source.roles.find((r) => r.id === op.sourceId);
        if (!role) return skip('the source role is gone');
        return roleCreate(projectSourceRole(role, projection));
    }
    if (op.kind === 'category' || op.kind === 'channel') {
        const channel = ctx.source.channels.find((c) => c.id === op.sourceId);
        if (!channel) return skip('the source channel is gone');
        const applied = projectSourceChannel(channel, projection);
        return {
            type: 'create-channel',
            spec: channelSpec(channel, applied, ctx.map, managedMembers(ctx)),
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
            tags: stickerTags(sticker.tags),
            applied: projectSticker(sticker),
        };
    }
    if (op.kind === 'thread') return createThread(op, ctx);
    return skip(`a ${op.kind} cannot be created`);
}

/**
 * A role patch from the changed fields. An `icon` value is still the
 * source's icon hash here; the executor swaps in the image.
 */
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
    ctx: WriteContext
): ChannelPatch {
    const patch: Record<string, unknown> = {};
    for (const change of changes) {
        if (change.field === 'overwrites') {
            patch.overwrites = mergeOverwrites(
                managedOverwrites(change.to),
                dest.overwrites,
                ctx.map,
                managedMembers(ctx, {
                    kind: channelMapKind(dest.type),
                    destId: dest.id,
                })
            );
        } else if (change.field === 'tags') patch.tags = names(change.to);
        else if (change.field === 'tagMeta') patch.tagMeta = tagMeta(change.to);
        else if (change.field === 'defaultReaction') {
            patch.defaultReaction = emojiChoice(change.to);
        } else patch[change.field] = change.to;
    }
    return patch as ChannelPatch;
}

/** A thread patch from the changed fields. The parent never changes. */
function threadPatch(changes: readonly FieldChange[]): ThreadPatch {
    const patch: Record<string, unknown> = {};
    for (const { field, to } of changes) {
        if (field === 'name' && typeof to === 'string') patch.name = to;
        else if (field === 'tags') patch.tags = names(to);
        else if (THREAD_FLAGS.has(field)) patch[field] = to === true;
        else if (THREAD_NUMBERS.has(field) && typeof to === 'number') {
            patch[field] = to;
        }
    }
    return patch as ThreadPatch;
}

const THREAD_FLAGS = new Set(['archived', 'locked', 'pinned', 'invitable']);
const THREAD_NUMBERS = new Set(['rateLimitPerUser', 'autoArchiveDuration']);

function createThread(op: CreateOp, ctx: WriteContext): WriteAction {
    const thread = ctx.source.threads.find((t) => t.id === op.sourceId);
    if (!thread) return skip('the source thread is gone');
    const parentId = ctx.map.dest('channel', thread.parentId);
    const parent = ctx.source.channels.find((c) => c.id === thread.parentId);
    if (!parentId || !parent) {
        return skip('the parent channel is not created yet');
    }
    const fields = projectSourceThread(thread, ctx);
    const { applied, followUp } = threadCreateSplit(fields);
    return {
        type: 'create-thread',
        parentId,
        parentSourceId: thread.parentId,
        parentType: parent.type,
        name: thread.name,
        tags: [...thread.tags],
        private: thread.private === true,
        invitable: thread.invitable !== false,
        applied,
        followUp,
    };
}

/**
 * What a new thread has before its follow-up: open, unpinned, no
 * slowmode. Its archive time is unknown until the follow-up sets it.
 */
const THREAD_CREATE_LATER: Readonly<Record<string, JsonValue | undefined>> = {
    archived: false,
    locked: false,
    pinned: false,
    rateLimitPerUser: 0,
    autoArchiveDuration: undefined,
};

/** Splits a new thread's fields into the create and its follow-up. */
function threadCreateSplit(fields: Fields): {
    applied: Fields;
    followUp: FollowUp | null;
} {
    const applied: Record<string, JsonValue> = { ...fields };
    const later: Record<string, JsonValue> = {};
    for (const [field, start] of Object.entries(THREAD_CREATE_LATER)) {
        const want = fields[field];
        if (want === undefined || want === start) continue;
        later[field] = want;
        if (start === undefined) delete applied[field];
        else applied[field] = start;
    }
    if (Object.keys(later).length === 0) return { applied, followUp: null };
    return {
        applied,
        followUp: {
            type: 'thread',
            patch: threadPatch(
                Object.entries(later).map(([field, to]) => ({
                    field,
                    from: null,
                    to,
                }))
            ),
            fields: later,
        },
    };
}

/**
 * The base an update records: what was settled at plan time, without any
 * changed field the write could not carry. Older plans lack `settled` and
 * record just the changes.
 */
function settledFields(op: UpdateOp, unwritten: readonly string[]): Fields {
    const base: Record<string, JsonValue> = op.settled
        ? { ...op.settled }
        : Object.fromEntries(op.changes.map((c) => [c.field, c.to]));
    for (const field of unwritten) delete base[field];
    return base;
}

/**
 * The fields a thread patch carries. Any other change is not written: the
 * parent, or whether the thread is private, never change after creation.
 */
const THREAD_FIELDS = new Set([
    'name',
    'archived',
    'locked',
    'tags',
    'pinned',
    'invitable',
    'rateLimitPerUser',
    'autoArchiveDuration',
]);

function updateAction(op: UpdateOp, ctx: WriteContext): WriteAction {
    if (op.kind === 'role') {
        const role = ctx.source.roles.find((r) => r.id === op.sourceId);
        const dest = ctx.destination.roles.find((r) => r.id === op.destId);
        if (!role || !dest) return skip('the role is gone on one side');
        return {
            type: 'update-role',
            patch: rolePatch(op.changes, dest.permissions),
            applied: settledFields(op, []),
        };
    }
    if (op.kind === 'category' || op.kind === 'channel') {
        const channel = ctx.source.channels.find((c) => c.id === op.sourceId);
        const dest = ctx.destination.channels.find((c) => c.id === op.destId);
        if (!channel || !dest) return skip('the channel is gone on one side');
        return {
            type: 'update-channel',
            patch: channelPatch(op.changes, dest, ctx),
            applied: settledFields(op, []),
        };
    }
    if (op.kind === 'guild') {
        const patch = Object.fromEntries(
            op.changes.map((c) => [c.field, c.to])
        ) as GuildPatch;
        return { type: 'update-guild', patch, applied: settledFields(op, []) };
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
        return { type: 'rename-emoji', name, applied: settledFields(op, []) };
    }
    if (op.kind === 'sticker') {
        const sticker = ctx.source.stickers.find((s) => s.id === op.sourceId);
        if (!sticker) return skip('the source sticker is gone');
        // Fluxer clears what an update leaves out, so all fields go.
        return {
            type: 'update-sticker',
            patch: {
                name: sticker.name,
                description: sticker.description,
                tags: stickerTags(sticker.tags),
            },
            applied: settledFields(op, []),
        };
    }
    if (op.kind === 'thread') {
        const thread = ctx.source.threads.find((t) => t.id === op.sourceId);
        const patch = threadPatch(op.changes);
        if (!thread || Object.keys(patch).length === 0) {
            return skip('nothing to write');
        }
        const unwritten = op.changes
            .map((c) => c.field)
            .filter((field) => !THREAD_FIELDS.has(field));
        return {
            type: 'update-thread',
            patch,
            applied: settledFields(op, unwritten),
        };
    }
    return skip(`a ${op.kind} cannot be updated`);
}

/** A locked channel, moved to the archive; a category is renamed instead. */
function archiveChannel(
    destId: string,
    destination: GuildSnapshot
): WriteAction {
    const channel = destination.channels.find((c) => c.id === destId);
    if (!channel) return { type: 'gone' };
    const overwrites = lockOverwrites(
        channel.overwrites,
        destination.everyoneRoleId
    );
    const isCategory = channelKind(channel.type) === 'category';
    return {
        type: 'archive-channel',
        move: !isCategory,
        patch: isCategory
            ? { name: archivedName(channel.name, ROLE_NAME_MAX), overwrites }
            : { overwrites },
    };
}

/** Soft delete (guard 5): the object stays, renamed or locked. */
function archiveAction(op: ArchiveOp, ctx: WriteContext): WriteAction {
    const { destination } = ctx;
    if (op.kind === 'role') {
        const role = destination.roles.find((r) => r.id === op.destId);
        if (!role) return { type: 'gone' };
        return {
            type: 'archive-role',
            patch: {
                name: archivedName(role.name, ROLE_NAME_MAX),
                permissions: NO_BITS.toString(),
            },
        };
    }
    if (op.kind === 'category' || op.kind === 'channel') {
        return archiveChannel(op.destId, destination);
    }
    if (op.kind === 'emoji') {
        const emoji = destination.emojis.find((e) => e.id === op.destId);
        if (!emoji) return { type: 'gone' };
        return {
            type: 'archive-emoji',
            name: archivedExpression(emoji.name, EMOJI_NAME_MAX),
        };
    }
    if (op.kind === 'sticker') {
        const sticker = destination.stickers.find((s) => s.id === op.destId);
        if (!sticker) return { type: 'gone' };
        return {
            type: 'archive-sticker',
            patch: {
                name: archivedExpression(sticker.name, STICKER_NAME_MAX),
                description: sticker.description,
                tags: stickerTags(sticker.tags),
            },
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

/**
 * The destination channels under one parent, in Fluxer's display order:
 * by position, and inside a category text-like before voice
 * (GuildChannelOrdering.ts sortChannelsForOrdering).
 */
function siblingsOf(
    channels: readonly ChannelSnap[],
    parentId: string | null
): ChannelSnap[] {
    const group = (c: ChannelSnap) =>
        parentId === null ? 0 : layoutGroup(c.type);
    return channels
        .filter((c) => (c.parentId ?? null) === parentId)
        .sort(
            (a, b) =>
                group(a) - group(b) ||
                a.position - b.position ||
                a.id.localeCompare(b.id)
        );
}

/**
 * Moves that give the listed channels the wanted order among their
 * siblings. Fluxer applies a list of moves one by one, each relative to a
 * preceding sibling (ChannelOperationsService.updateChannelPositionsByList),
 * so global positions do not work. Listed channels take over the slots
 * they hold now; every other sibling stays where it is. Sent in final
 * order, each move lands after a channel that already sits where it
 * should, and inside a category a text-like channel never lands below a
 * voice channel, so every step passes Fluxer's voice placement check.
 */
export function channelMoves(
    destIds: readonly string[],
    channels: readonly ChannelSnap[],
    parentId: string | null
): { moves: ChannelMove[]; placed: string[] } {
    const siblings = siblingsOf(channels, parentId);
    const present = new Set(siblings.map((c) => c.id));
    const placed = destIds.filter((id) => present.has(id));
    const listed = new Set(placed);
    let next = 0;
    const final = siblings.map((c) =>
        listed.has(c.id) ? placed[next++] : c.id
    );
    const moves: ChannelMove[] = [];
    final.forEach((id, index) => {
        if (!listed.has(id)) return;
        moves.push({ id, precedingId: index === 0 ? null : final[index - 1] });
    });
    return { moves, placed };
}

/** The destination parent a channel scope's objects sit under. */
function scopeParent(scope: string): string | null {
    return scope === 'top' || scope === 'categories' ? null : scope;
}

function reorderAction(op: ReorderOp, ctx: WriteContext): WriteAction {
    if (op.kind === 'channel') {
        const ids = new Set(ctx.destination.channels.map((c) => c.id));
        if (op.destIds.some((id) => !ids.has(id))) {
            return skip('an object in the order is gone');
        }
        const { moves, placed } = channelMoves(
            op.destIds,
            ctx.destination.channels,
            scopeParent(op.scope)
        );
        if (placed.length < 2) return skip('the channels moved elsewhere');
        return { type: 'channel-positions', moves, placed };
    }
    const positions = positionsFor(
        op.destIds,
        new Map(ctx.destination.roles.map((item) => [item.id, item.position]))
    );
    if (!positions) return skip('an object in the order is gone');
    return { type: 'role-positions', positions };
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

import type { SyncDirection } from '../addons/db/schema';
import { IdMap } from './idmap';
import type { FieldChange, Finding, MapRow, PlanOp, SyncKind } from './ops';
import { diffOrders } from './order';
import {
    ADMINISTRATOR,
    NO_BITS,
    flagNames,
    translatePermissions,
} from './permissions';
import type { Fields, ProjectionContext } from './project';
import {
    projectDestChannel,
    projectDestRole,
    projectDestThread,
    projectEmoji,
    projectSourceChannel,
    projectSourceRole,
    projectSourceThread,
    projectSticker,
} from './project';
import type {
    ChannelSnap,
    GuildSnapshot,
    RoleSnap,
    ThreadSnap,
} from './snapshot';
import { THREAD_PARENT_TYPES, channelKind } from './snapshot';

/** Fluxer refuses a 51st channel in one category (ChannelHelpers.ts). */
export const MAX_CHANNELS_PER_CATEGORY = 50;

export interface DiffInput {
    readonly source: GuildSnapshot;
    readonly destination: GuildSnapshot;
    /** The last healthy source snapshot, to tell source edits from drift. */
    readonly previousSource: GuildSnapshot | null;
    readonly rows: readonly MapRow[];
    readonly direction: SyncDirection;
    /**
     * Source channels and threads never synced (BF_ADDONS_EXCLUDE_CHANNELS,
     * expanded with excludedIds). A copy that already exists stays as it
     * is: an excluded channel is neither updated nor removed.
     */
    readonly excluded?: ReadonlySet<string>;
    /**
     * Which source channels the relay already bridges, and which must never
     * be bridged (the admin channel). Without it, no link is planned.
     */
    readonly links?: {
        readonly linked: ReadonlySet<string>;
        readonly never: ReadonlySet<string>;
        /**
         * With history import on: the text and announcement channels whose
         * past messages are copied. Any other one waits, because a bridge
         * opened earlier would put live chat above the history.
         */
        readonly historyReady?: ReadonlySet<string>;
    };
}

export interface DiffResult {
    readonly ops: PlanOp[];
    readonly findings: Finding[];
}

interface Out {
    readonly ops: PlanOp[];
    readonly findings: Finding[];
}

const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);

/**
 * Splits differing fields into source changes and destination drift. A
 * field counts as a source change only when the source value differs from
 * the base: the fields last written to the destination, or the last
 * healthy source snapshot when nothing was written yet. Otherwise the
 * destination was edited by hand, which guard 8 reports and never reverts.
 * On a first sync there is no base, and every difference follows the source.
 */
export function compareFields(
    desired: Fields,
    actual: Fields,
    previous: Fields | null,
    firstSync = false
): { changes: FieldChange[]; drifted: string[] } {
    const changes: FieldChange[] = [];
    const drifted: string[] = [];
    for (const [field, to] of Object.entries(desired)) {
        if (!(field in actual) || same(to, actual[field])) continue;
        const moved =
            firstSync || (previous !== null && !same(previous[field], to));
        if (moved) changes.push({ field, from: actual[field], to });
        else drifted.push(field);
    }
    return { changes, drifted };
}

interface ObjectSpec<T extends { readonly id: string; readonly name: string }> {
    readonly kind: SyncKind;
    readonly sources: readonly T[];
    readonly dests: readonly T[];
    readonly previous: readonly T[] | null;
    readonly projectSource: (item: T) => Fields;
    readonly projectDest: (item: T) => Fields;
    readonly sameType: (a: T, b: T) => boolean;
    readonly skipReason: (item: T) => string | null;
    /** True for an object that syncs without a map row, such as @everyone. */
    readonly implicit?: (item: T) => boolean;
}

function createOp<T extends { readonly id: string; readonly name: string }>(
    spec: ObjectSpec<T>,
    map: IdMap,
    item: T
): PlanOp {
    const existing = spec.dests.find(
        (dest) =>
            !map.mayUpdate(spec.kind, dest.id) &&
            dest.name === item.name &&
            spec.sameType(item, dest)
    );
    return {
        op: 'create',
        kind: spec.kind,
        sourceId: item.id,
        name: item.name,
        existingDestId: existing?.id ?? null,
    };
}

/** Compares one mapped pair against its base (see compareFields). */
function compareMapped<
    T extends { readonly id: string; readonly name: string },
>(spec: ObjectSpec<T>, map: IdMap, item: T, dest: T, prev: T | undefined) {
    const firstSync =
        spec.implicit?.(item) === true && !map.hasRow(spec.kind, item.id);
    const base =
        map.applied(spec.kind, item.id) ??
        (prev ? spec.projectSource(prev) : null);
    const compared = compareFields(
        spec.projectSource(item),
        spec.projectDest(dest),
        base,
        firstSync
    );
    return { ...compared, firstSync };
}

function diffObjects<T extends { readonly id: string; readonly name: string }>(
    spec: ObjectSpec<T>,
    map: IdMap,
    out: Out
): void {
    const destById = new Map(spec.dests.map((item) => [item.id, item]));
    const prevById = new Map((spec.previous ?? []).map((i) => [i.id, i]));
    for (const item of spec.sources) {
        const skip = spec.skipReason(item);
        if (skip) {
            out.findings.push({
                type: 'skipped',
                kind: spec.kind,
                id: item.id,
                detail: skip,
            });
            continue;
        }
        const destId = map.dest(spec.kind, item.id);
        if (!destId) {
            out.ops.push(createOp(spec, map, item));
            continue;
        }
        const dest = destById.get(destId);
        if (!dest) {
            out.findings.push({
                type: 'missing-on-destination',
                kind: spec.kind,
                id: destId,
                detail: `mapped from ${item.id}, not found on the destination`,
            });
            continue;
        }
        const { changes, drifted, firstSync } = compareMapped(
            spec,
            map,
            item,
            dest,
            prevById.get(item.id)
        );
        if (changes.length > 0) {
            out.ops.push({
                op: 'update',
                kind: spec.kind,
                sourceId: item.id,
                destId,
                changes,
                ...(firstSync ? { baseline: true as const } : {}),
            });
        }
        if (drifted.length > 0) {
            out.findings.push({
                type: 'drift',
                kind: spec.kind,
                id: destId,
                detail: `edited on the destination: ${drifted.join(', ')}`,
            });
        }
    }
}

function roleSkip(role: RoleSnap): string | null {
    return role.managed ? 'managed role (bot, integration or booster)' : null;
}

function channelSkip(channel: ChannelSnap): string | null {
    return channelKind(channel.type)
        ? null
        : `channel type ${channel.type} is not synced`;
}

const isCategory = (c: ChannelSnap) => channelKind(c.type) === 'category';
const notCategory = (c: ChannelSnap) => !isCategory(c);

function diffStructure(input: DiffInput, ctx: ProjectionContext, out: Out) {
    const { source, destination, previousSource } = input;
    // Creates run in source order, so new channels land in that order.
    const channelSpec = (
        filter: (c: ChannelSnap) => boolean,
        kind: SyncKind
    ) => ({
        kind,
        sources: source.channels
            .filter(filter)
            .sort((a, b) => a.position - b.position),
        dests: destination.channels.filter(filter),
        previous: previousSource?.channels.filter(filter) ?? null,
        projectSource: (c: ChannelSnap) => projectSourceChannel(c, ctx),
        projectDest: (c: ChannelSnap) => projectDestChannel(c, ctx),
        sameType: (a: ChannelSnap, b: ChannelSnap) => a.type === b.type,
        skipReason: (c: ChannelSnap) =>
            input.excluded?.has(c.id)
                ? 'excluded by BF_ADDONS_EXCLUDE_CHANNELS'
                : channelSkip(c),
    });
    diffObjects(
        {
            kind: 'role',
            sources: [...source.roles].sort((a, b) => a.position - b.position),
            dests: destination.roles,
            previous: previousSource?.roles ?? null,
            projectSource: (r) => projectSourceRole(r, ctx),
            projectDest: (r) => projectDestRole(r, ctx),
            sameType: () => true,
            skipReason: roleSkip,
            implicit: (r) => r.id === source.everyoneRoleId,
        },
        ctx.map,
        out
    );
    diffObjects(channelSpec(isCategory, 'category'), ctx.map, out);
    diffObjects(channelSpec(notCategory, 'channel'), ctx.map, out);
}

function diffExpressions(input: DiffInput, map: IdMap, out: Out) {
    const { source, destination, previousSource } = input;
    diffObjects(
        {
            kind: 'emoji',
            sources: source.emojis,
            dests: destination.emojis,
            previous: previousSource?.emojis ?? null,
            projectSource: projectEmoji,
            projectDest: projectEmoji,
            sameType: (a, b) => a.animated === b.animated,
            skipReason: () => null,
        },
        map,
        out
    );
    diffObjects(
        {
            kind: 'sticker',
            sources: source.stickers,
            dests: destination.stickers,
            previous: previousSource?.stickers ?? null,
            projectSource: projectSticker,
            projectDest: projectSticker,
            sameType: () => true,
            skipReason: () => null,
        },
        map,
        out
    );
}

function diffGuild(input: DiffInput, map: IdMap, out: Out) {
    const { source, destination, previousSource } = input;
    const prevName = previousSource ? { name: previousSource.name } : null;
    const firstSync = !map.hasRow('guild', source.guildId);
    const { changes, drifted } = compareFields(
        { name: source.name },
        { name: destination.name },
        map.applied('guild', source.guildId) ?? prevName,
        firstSync
    );
    // The server icon and banner are not synced. Each server keeps its own.
    const destId = destination.guildId;
    if (changes.length > 0) {
        out.ops.push({
            op: 'update',
            kind: 'guild',
            sourceId: source.guildId,
            destId,
            changes,
            ...(firstSync ? { baseline: true as const } : {}),
        });
    }
    if (drifted.length > 0) {
        out.findings.push({
            type: 'drift',
            kind: 'guild',
            id: destId,
            detail: 'server name edited on the destination',
        });
    }
}

function reportPermissions(input: DiffInput, out: Out) {
    for (const role of input.source.roles) {
        if (role.managed) continue;
        const { dropped } = translatePermissions(
            BigInt(role.permissions),
            input.direction
        );
        if (dropped.length === 0) continue;
        out.findings.push({
            type: 'permission-dropped',
            kind: 'role',
            id: role.id,
            detail: `no counterpart on the destination: ${dropped.join(', ')}`,
        });
    }
}

function reportFullCategories(source: GuildSnapshot, out: Out) {
    const counts = new Map<string, number>();
    for (const channel of source.channels) {
        if (!channel.parentId || !channelKind(channel.type)) continue;
        counts.set(channel.parentId, (counts.get(channel.parentId) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
        if (count <= MAX_CHANNELS_PER_CATEGORY) continue;
        out.findings.push({
            type: 'category-full',
            kind: 'category',
            id,
            detail: `${count} channels, over the destination limit of ${MAX_CHANNELS_PER_CATEGORY}`,
        });
    }
}

/** Bits the plan would grant that the destination bot does not hold. */
function reportBotPermissions(input: DiffInput, out: Out) {
    const { destination, source, direction } = input;
    const bot = destination.bot;
    if (!bot || bot.isOwner) return;
    const held = destination.roles
        .filter(
            (r) =>
                r.id === destination.everyoneRoleId ||
                bot.roleIds.includes(r.id)
        )
        .reduce((bits, r) => bits | BigInt(r.permissions), NO_BITS);
    if ((held & ADMINISTRATOR) !== NO_BITS) return;
    let granted = NO_BITS;
    for (const role of source.roles) {
        if (!role.managed)
            granted |= translatePermissions(
                BigInt(role.permissions),
                direction
            ).bits;
    }
    for (const channel of source.channels) {
        for (const ow of channel.overwrites) {
            granted |= translatePermissions(BigInt(ow.allow), direction).bits;
        }
    }
    const missing = granted & ~held;
    if (missing === NO_BITS) return;
    // Name the bits as the destination library does.
    const destNames: SyncDirection =
        direction === 'discord-to-fluxer'
            ? 'fluxer-to-discord'
            : 'discord-to-fluxer';
    out.findings.push({
        type: 'not-held-by-bot',
        kind: 'guild',
        id: destination.guildId,
        detail: `the destination bot would be refused these grants: ${flagNames(missing, destNames).join(', ')}`,
    });
}

/** One link op for each mapped text, announcement or forum channel. */
function diffLinks(input: DiffInput, map: IdMap, out: Out) {
    if (!input.links) return;
    const present = new Set(input.destination.channels.map((c) => c.id));
    for (const channel of input.source.channels) {
        if (!THREAD_PARENT_TYPES.has(channel.type)) continue;
        if (input.links.linked.has(channel.id)) continue;
        if (input.links.never.has(channel.id)) continue;
        if (input.excluded?.has(channel.id)) continue;
        const ready = input.links.historyReady;
        if (
            ready &&
            channelKind(channel.type) !== 'forum' &&
            !ready.has(channel.id)
        ) {
            continue;
        }
        const destId = map.dest('channel', channel.id);
        if (!destId || !present.has(destId)) continue;
        out.ops.push({
            op: 'link',
            kind: 'channel',
            sourceId: channel.id,
            destId,
        });
    }
}

/** Threads and forum posts whose parent channel is already mapped. */
function diffThreads(input: DiffInput, ctx: ProjectionContext, out: Out) {
    const { source, destination, previousSource } = input;
    for (const parentId of source.threadGaps) {
        out.findings.push({
            type: 'skipped',
            kind: 'thread',
            id: parentId,
            detail: 'threads in this channel could not be listed; the bot may lack Read Message History',
        });
    }
    // An incomplete list must not create, change or remove anything.
    if (source.threadGaps.length > 0 || destination.threadGaps.length > 0) {
        return;
    }
    const mapped = (t: ThreadSnap) => ctx.map.dest('channel', t.parentId);
    const included = (t: ThreadSnap) => !input.excluded?.has(t.id);
    diffObjects(
        {
            kind: 'thread',
            sources: source.threads.filter(
                (t) => included(t) && mapped(t) !== null
            ),
            dests: destination.threads,
            previous: previousSource?.threads ?? null,
            projectSource: (t) => projectSourceThread(t, ctx),
            projectDest: projectDestThread,
            sameType: (a, b) => mapped(a) === b.parentId,
            skipReason: () => null,
        },
        ctx.map,
        out
    );
}

/**
 * Computes the ops that bring the destination in line with the source.
 * Pure: no network, no database, no clock. Removals are not decided here;
 * they need the confirmation guards (see guards.ts).
 */
export function diff(input: DiffInput): DiffResult {
    const map = IdMap.from(
        input.rows,
        input.direction,
        input.source,
        input.destination
    );
    const ctx: ProjectionContext = { map, direction: input.direction };
    const out: Out = { ops: [], findings: [] };
    diffStructure(input, ctx, out);
    diffExpressions(input, map, out);
    diffLinks(input, map, out);
    diffThreads(input, ctx, out);
    diffGuild(input, map, out);
    diffOrders(input, map, out);
    reportPermissions(input, out);
    reportFullCategories(input.source, out);
    reportBotPermissions(input, out);
    return out;
}

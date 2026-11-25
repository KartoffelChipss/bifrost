import type { IdMap } from './idmap';
import type { Finding, PlanOp } from './ops';
import type { ChannelSnap, GuildSnapshot } from './snapshot';
import { channelKind } from './snapshot';

/**
 * Order diffs compare relative order, not raw positions: the two platforms
 * number positions differently, but the order of mapped pairs must match.
 */

/**
 * Set in a new object's applied fields until a reorder placed it. Without
 * it, a new object would sit wherever the platform put it, and the next
 * diff would call that "edited on the destination".
 */
export const ORDER_PENDING = 'orderPending';

export interface OrderPair {
    readonly sourceId: string;
    readonly destId: string;
    readonly sourcePos: number;
    readonly destPos: number;
    /** Position in the last healthy source snapshot, or null if new. */
    readonly prevPos: number | null;
    /** Created by the sync and not placed by a reorder yet. */
    readonly pending?: boolean;
    /**
     * Sort group inside a category: Fluxer always lists text-like channels
     * above voice channels there (GuildChannelOrdering.ts), whatever the
     * positions say. Zero everywhere else.
     */
    readonly group?: number;
}

/** Fluxer's channelLayoutRank: text-like, then voice, then the rest. */
export function layoutGroup(type: number): number {
    if (TEXT_LIKE_TYPES.has(type)) return 0;
    return VOICE_LIKE_TYPES.has(type) ? 1 : 2;
}

/** Text, announcement, forum and media channels. */
const TEXT_LIKE_TYPES: ReadonlySet<number> = new Set([0, 5, 15, 16]);
/** Voice, and stage channels, which Fluxer gets as voice channels. */
const VOICE_LIKE_TYPES: ReadonlySet<number> = new Set([2, 13]);

interface OrderInput {
    readonly source: GuildSnapshot;
    readonly destination: GuildSnapshot;
    readonly previousSource: GuildSnapshot | null;
    /** Restore the source order even when the destination was moved. */
    readonly enforce?: boolean;
}

interface Out {
    readonly ops: PlanOp[];
    readonly findings: Finding[];
}

function sortedDestIds(
    pairs: readonly OrderPair[],
    pos: (pair: OrderPair) => number,
    id: (pair: OrderPair) => string
): string[] {
    return [...pairs]
        .sort(
            (a, b) =>
                (a.group ?? 0) - (b.group ?? 0) ||
                pos(a) - pos(b) ||
                id(a).localeCompare(id(b))
        )
        .map((pair) => pair.destId);
}

/** One reorder op, one drift finding, or nothing. */
export function diffOrder(
    kind: 'role' | 'channel',
    scope: string,
    pairs: readonly OrderPair[],
    enforce = false
): { op: PlanOp } | { drift: Finding } | null {
    if (pairs.length < 2) return null;
    const wanted = sortedDestIds(
        pairs,
        (p) => p.sourcePos,
        (p) => p.sourceId
    );
    const actual = sortedDestIds(
        pairs,
        (p) => p.destPos,
        (p) => p.destId
    );
    const pending = pairs.some((pair) => pair.pending === true);
    // A pending object in the right place still gets a reorder, so its
    // flag clears; after that, a move on the destination is drift.
    if (wanted.join() === actual.join() && !pending) return null;
    const known =
        !enforce && !pending && pairs.every((pair) => pair.prevPos !== null);
    const before = known
        ? sortedDestIds(
              pairs,
              (p) => p.prevPos ?? 0,
              (p) => p.sourceId
          )
        : null;
    if (before && before.join() === wanted.join()) {
        return {
            drift: {
                type: 'drift',
                kind,
                id: scope,
                detail: 'order edited on the destination',
            },
        };
    }
    return { op: { op: 'reorder', kind, scope, destIds: wanted } };
}

function pairsFor<T extends { id: string; position: number }>(
    sources: readonly T[],
    dests: readonly T[],
    previous: readonly T[] | null,
    destIdOf: (item: T) => string | null,
    isPending: (item: T) => boolean,
    groupOf: (item: T) => number = () => 0
): OrderPair[] {
    const destById = new Map(dests.map((item) => [item.id, item]));
    const prevById = new Map((previous ?? []).map((item) => [item.id, item]));
    const pairs: OrderPair[] = [];
    for (const item of sources) {
        const destId = destIdOf(item);
        const dest = destId ? destById.get(destId) : undefined;
        if (!destId || !dest) continue;
        pairs.push({
            sourceId: item.id,
            destId,
            sourcePos: item.position,
            destPos: dest.position,
            prevPos: prevById.get(item.id)?.position ?? null,
            pending: isPending(item),
            group: groupOf(dest),
        });
    }
    return pairs;
}

function push(out: Out, result: ReturnType<typeof diffOrder>) {
    if (!result) return;
    if ('op' in result) out.ops.push(result.op);
    else out.findings.push(result.drift);
}

function channelScopes(
    input: OrderInput,
    map: IdMap
): Map<string, ChannelSnap[]> {
    const scopes = new Map<string, ChannelSnap[]>();
    for (const channel of input.source.channels) {
        const kind = channelKind(channel.type);
        if (!kind) continue;
        let scope = 'top';
        if (kind === 'category') scope = 'categories';
        else if (channel.parentId) {
            scope = map.dest('category', channel.parentId) ?? '';
        }
        if (scope === '') continue;
        scopes.set(scope, [...(scopes.get(scope) ?? []), channel]);
    }
    return scopes;
}

/** Scopes that are not a category: no type grouping applies there. */
const ROOT_SCOPES: ReadonlySet<string> = new Set(['top', 'categories']);

/**
 * True when the source lists a voice channel above a text-like one in a
 * category. Fluxer refuses that order, so the copy keeps text first.
 */
function voiceAboveText(channels: readonly ChannelSnap[]): boolean {
    const sorted = [...channels].sort(
        (a, b) => a.position - b.position || a.id.localeCompare(b.id)
    );
    let voiceSeen = false;
    for (const channel of sorted) {
        const group = layoutGroup(channel.type);
        if (group === 1) voiceSeen = true;
        else if (group === 0 && voiceSeen) return true;
    }
    return false;
}

function diffChannelScope(
    input: OrderInput,
    map: IdMap,
    scope: string,
    channels: readonly ChannelSnap[],
    out: Out
): void {
    const kindOf = (c: ChannelSnap) =>
        channelKind(c.type) === 'category' ? 'category' : 'channel';
    const grouped = !ROOT_SCOPES.has(scope);
    const pairs = pairsFor(
        channels,
        input.destination.channels,
        input.previousSource?.channels ?? null,
        (c) => map.dest(kindOf(c), c.id),
        (c) => map.applied(kindOf(c), c.id)?.[ORDER_PENDING] === true,
        (c) => (grouped ? layoutGroup(c.type) : 0)
    );
    if (grouped && pairs.length > 1 && voiceAboveText(channels)) {
        out.findings.push({
            type: 'skipped',
            kind: 'channel',
            id: scope,
            detail: 'order differs: Fluxer keeps voice channels below text',
        });
    }
    push(out, diffOrder('channel', scope, pairs, input.enforce === true));
}

/** Reorder ops for roles and for each channel scope. */
export function diffOrders(input: OrderInput, map: IdMap, out: Out): void {
    const roles = input.source.roles.filter(
        (role) => !role.managed && role.id !== input.source.everyoneRoleId
    );
    push(
        out,
        diffOrder(
            'role',
            'roles',
            pairsFor(
                roles,
                input.destination.roles,
                input.previousSource?.roles ?? null,
                (r) => map.dest('role', r.id),
                (r) => map.applied('role', r.id)?.[ORDER_PENDING] === true
            ),
            input.enforce === true
        )
    );
    for (const [scope, channels] of channelScopes(input, map)) {
        diffChannelScope(input, map, scope, channels, out);
    }
}

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
}

interface OrderInput {
    readonly source: GuildSnapshot;
    readonly destination: GuildSnapshot;
    readonly previousSource: GuildSnapshot | null;
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
        .sort((a, b) => pos(a) - pos(b) || id(a).localeCompare(id(b)))
        .map((pair) => pair.destId);
}

/** One reorder op, one drift finding, or nothing. */
export function diffOrder(
    kind: 'role' | 'channel',
    scope: string,
    pairs: readonly OrderPair[]
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
    const known = !pending && pairs.every((pair) => pair.prevPos !== null);
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
    isPending: (item: T) => boolean
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
            )
        )
    );
    for (const [scope, channels] of channelScopes(input, map)) {
        const kindOf = (c: ChannelSnap) =>
            channelKind(c.type) === 'category' ? 'category' : 'channel';
        const pairs = pairsFor(
            channels,
            input.destination.channels,
            input.previousSource?.channels ?? null,
            (c) => map.dest(kindOf(c), c.id),
            (c) => map.applied(kindOf(c), c.id)?.[ORDER_PENDING] === true
        );
        push(out, diffOrder('channel', scope, pairs));
    }
}

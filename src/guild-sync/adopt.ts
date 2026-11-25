import type { IdMap } from './idmap';
import type { PlanOp, SyncKind } from './ops';
import type { GuildSnapshot } from './snapshot';

/**
 * Safe adoption of objects a create made but never recorded: the write
 * timed out after the platform finished it, or the process stopped
 * before the map row was saved. Before every create, apply.ts records an
 * intent. An unowned destination object with the same name and type,
 * made after that intent, is that create's result and is adopted as
 * created by sync. An object that existed before any intent is someone
 * else's and stays untouched.
 */

/** A create the bot was about to send. */
export interface CreateIntent {
    readonly kind: SyncKind;
    readonly sourceId: string;
    readonly name: string;
    readonly at: Date;
}

/** How far back intents count. A create resolves long before this. */
export const INTENT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Bound on intents one cycle reads. */
export const MAX_INTENTS = 500;

/**
 * Allowed clock difference between this host and the platform: an object
 * stamped up to this long before the intent still counts as after it.
 */
export const CLOCK_SKEW_MS = 2 * 60_000;

/** Fluxer's and Discord's snowflake epoch (packages/constants Core.ts). */
const SNOWFLAKE_EPOCH = 1420070400000;
/** Worker and sequence bits below the timestamp (Snowflake.ts). */
const TIMESTAMP_SHIFT = BigInt(22);

/** The creation time of a snowflake ID, or null for anything else. */
export function snowflakeTime(id: string): number | null {
    if (!/^\d{1,20}$/.test(id)) return null;
    return Number(BigInt(id) >> TIMESTAMP_SHIFT) + SNOWFLAKE_EPOCH;
}

type CreateOp = Extract<PlanOp, { op: 'create' }>;

/** True when the object was made after the intent, within the skew. */
function madeAfter(destId: string, intent: CreateIntent): boolean {
    const time = snowflakeTime(destId);
    return time !== null && time >= intent.at.getTime() - CLOCK_SKEW_MS;
}

/** The latest intent for one create, if any. */
function intentFor(
    intents: readonly CreateIntent[],
    op: CreateOp
): CreateIntent | null {
    let latest: CreateIntent | null = null;
    for (const intent of intents) {
        if (intent.kind !== op.kind || intent.sourceId !== op.sourceId) {
            continue;
        }
        if (intent.name !== op.name) continue;
        if (!latest || intent.at > latest.at) latest = intent;
    }
    return latest;
}

/** An unowned thread or post with the op's name in the mapped parent. */
function threadMatch(
    op: CreateOp,
    source: GuildSnapshot,
    destination: GuildSnapshot,
    map: IdMap
): string | null {
    const thread = source.threads.find((t) => t.id === op.sourceId);
    const parent = thread ? map.dest('channel', thread.parentId) : null;
    if (!parent) return null;
    const match = destination.threads.find(
        (t) =>
            t.parentId === parent &&
            t.name === op.name &&
            !map.owns('thread', t.id)
    );
    return match?.id ?? null;
}

export interface AdoptionInput {
    readonly ops: readonly PlanOp[];
    readonly intents: readonly CreateIntent[];
    readonly source: GuildSnapshot;
    readonly destination: GuildSnapshot;
    readonly map: IdMap;
}

/**
 * Marks creates whose earlier attempt already made the object. Each
 * destination object is adopted by one create at most.
 */
export function markAdoptions(input: AdoptionInput): PlanOp[] {
    const taken = new Set<string>();
    return input.ops.map((op) => {
        if (op.op !== 'create') return op;
        const intent = intentFor(input.intents, op);
        if (!intent) return op;
        const destId =
            op.kind === 'thread'
                ? threadMatch(op, input.source, input.destination, input.map)
                : op.existingDestId;
        if (!destId || taken.has(destId) || !madeAfter(destId, intent)) {
            return op;
        }
        taken.add(destId);
        return { ...op, existingDestId: destId, adopt: true };
    });
}

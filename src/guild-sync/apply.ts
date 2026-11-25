import type { ObjectState, SyncDirection } from '../addons/db/schema';
import type { AddonLogger } from '../addons/isolation';
import type { AssetSource } from './assets';
import { IdMap } from './idmap';
import type { ChannelLinker, ThreadSource } from './links';
import type { JsonValue, MapRow, PlanOp } from './ops';
import { destIdOf } from './ops';
import type { Plan } from './plan';
import { projectSourceRole, type Fields } from './project';
import type { GuildSnapshot } from './snapshot';
import type { GuildSyncStore } from './store';
import {
    ARCHIVE_CATEGORY,
    LOCK_BITS,
    writeFor,
    type WriteAction,
    type WriteContext,
} from './writes';
import type { GuildWriter } from './writers/writer';

/**
 * Pauses after a write, sized to Fluxer's per-guild route limits
 * (GuildRateLimitConfig.ts): 10 role or channel creates or deletes a
 * minute, 10 emoji or sticker creates or deletes in 30 seconds, and 20
 * updates in 10 seconds.
 */
export const SLOW_WRITE_MS = 6_500;
export const EXPRESSION_WRITE_MS = 3_200;
export const UPDATE_WRITE_MS = 1_000;

type Write = Exclude<WriteAction, { type: 'skip' }>;

/** The pause one write needs before the next. */
export function pauseAfter(action: Write, kind: PlanOp['kind']): number {
    const expression = kind === 'emoji' || kind === 'sticker';
    switch (action.type) {
        case 'create-role':
        case 'create-channel':
        case 'archive-channel':
            return SLOW_WRITE_MS;
        case 'link':
            return SLOW_WRITE_MS;
        case 'create-emoji':
        case 'create-sticker':
        case 'create-thread':
            return EXPRESSION_WRITE_MS;
        case 'delete':
            return expression ? EXPRESSION_WRITE_MS : SLOW_WRITE_MS;
        default:
            return UPDATE_WRITE_MS;
    }
}

/** A cycle stops applying after this many failed writes. */
export const MAX_FAILURES_PER_CYCLE = 3;

export interface ApplyInput {
    readonly plan: Plan;
    readonly source: GuildSnapshot;
    readonly destination: GuildSnapshot;
    /** The object map the plan was built from. */
    readonly rows: readonly MapRow[];
}

export interface ApplyDeps {
    readonly store: GuildSyncStore;
    readonly writer: GuildWriter;
    /** Emoji and sticker images, read from the source. */
    readonly assets: AssetSource;
    /** Bifröst's channel links, or null when the relay is not wired in. */
    readonly links: ChannelLinker | null;
    /** First messages of threads and posts, read from the source. */
    readonly threads: ThreadSource | null;
    /** Checked before every write (guards 9, 10 and 15). */
    readonly canWrite: () => boolean;
    readonly pause: (ms: number) => Promise<void>;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

export interface ApplyResult {
    readonly applied: number;
    readonly failed: number;
    readonly skipped: readonly { op: PlanOp; reason: string }[];
    /** Why the run ended before the last op, or null. */
    readonly stopped: string | null;
}

/** What one run carries from op to op. */
interface RunState {
    readonly input: ApplyInput;
    readonly deps: ApplyDeps;
    rows: MapRow[];
    map: IdMap;
    applied: number;
    failed: number;
    readonly skipped: { op: PlanOp; reason: string }[];
    /** The archive category, once found or created in this run. */
    archiveCategoryId: string | null;
}

function buildMap(state: RunState): IdMap {
    const { plan, source, destination } = state.input;
    return IdMap.from(state.rows, plan.direction, source, destination);
}

function pair(direction: SyncDirection, sourceId: string, destId: string) {
    return direction === 'discord-to-fluxer'
        ? { discordId: sourceId, fluxerId: destId }
        : { discordId: destId, fluxerId: sourceId };
}

/** Finds the archive category, or creates it locked for @everyone. */
async function archiveCategory(state: RunState): Promise<string> {
    if (state.archiveCategoryId) return state.archiveCategoryId;
    const { destination } = state.input;
    const existing = destination.channels.find(
        (c) => c.type === CATEGORY_TYPE && c.name === ARCHIVE_CATEGORY
    );
    state.archiveCategoryId =
        existing?.id ??
        (await state.deps.writer.createChannel(destination.guildId, {
            type: CATEGORY_TYPE,
            name: ARCHIVE_CATEGORY,
            parentId: null,
            topic: null,
            nsfw: false,
            rateLimitPerUser: 0,
            bitrate: null,
            userLimit: null,
            tags: [],
            overwrites: [
                {
                    id: destination.everyoneRoleId,
                    type: 0,
                    allow: '0',
                    deny: LOCK_BITS.toString(),
                },
            ],
        }));
    return state.archiveCategoryId;
}

const CATEGORY_TYPE = 4;
const FORUM_TYPE = 15;

/** A write that must wait for an earlier one, such as a channel link. */
export class NotReadyError extends Error {}

/** Bridges a channel pair through Bifröst's relay. */
async function linkChannels(state: RunState, op: PlanOp): Promise<null> {
    const { plan } = state.input;
    const { links } = state.deps;
    if (op.op !== 'link') return null;
    if (!links) throw new NotReadyError('channel linking is not available');
    const ids = pair(plan.direction, op.sourceId, op.destId);
    await links.link(plan.guildLinkId, ids.discordId, ids.fluxerId);
    return null;
}

/** Creates a thread, or a forum post with its first message. */
async function createThread(
    state: RunState,
    action: Extract<Write, { type: 'create-thread' }>,
    sourceId: string
): Promise<string> {
    const { plan, source, destination } = state.input;
    const { writer, links, threads } = state.deps;
    let starter = null;
    let webhook = null;
    if (action.parentType === FORUM_TYPE) {
        const toFluxer = plan.direction === 'discord-to-fluxer';
        const link = toFluxer
            ? await links?.byDiscordChannel(action.parentSourceId)
            : await links?.byFluxerChannel(action.parentSourceId);
        if (!link || !threads) {
            throw new NotReadyError('the forum is not linked yet');
        }
        webhook = toFluxer ? link.fluxerWebhook : link.discordWebhook;
        starter = await threads.starter(source.guildId, sourceId);
    }
    const id = await writer.createThread(destination.guildId, {
        parentId: action.parentId,
        parentType: action.parentType,
        name: action.name,
        tags: action.tags,
        starter,
        webhook,
    });
    if (action.archived || action.locked) {
        await writer.updateThread(destination.guildId, id, {
            archived: action.archived,
            locked: action.locked,
        });
    }
    return id;
}

/** Hard delete (guard 6). A channel loses its relay link first. */
async function deleteObject(
    state: RunState,
    op: PlanOp,
    destId: string
): Promise<void> {
    const { plan, destination } = state.input;
    const { writer, links } = state.deps;
    const guildId = destination.guildId;
    if (op.kind === 'role') return writer.deleteRole(guildId, destId);
    if (op.kind === 'emoji') return writer.deleteEmoji(guildId, destId);
    if (op.kind === 'sticker') return writer.deleteSticker(guildId, destId);
    if (op.kind === 'thread') return writer.deleteThread(guildId, destId);
    if (links && 'sourceId' in op) {
        const ids = pair(plan.direction, op.sourceId, destId);
        await links.unlink(ids.discordId);
    }
    return writer.deleteChannel(guildId, destId);
}

/** Creates and removals. Returns the new ID for a create, else null. */
async function performLifecycle(
    state: RunState,
    action: Write,
    op: PlanOp,
    destId: string
): Promise<string | null> {
    const { source, destination } = state.input;
    const { writer, assets } = state.deps;
    const guildId = destination.guildId;
    switch (action.type) {
        case 'create-role':
            return writer.createRole(guildId, action.spec);
        case 'create-channel':
            return writer.createChannel(guildId, action.spec);
        case 'create-emoji':
        case 'create-sticker': {
            const kind = action.type === 'create-emoji' ? 'emoji' : 'sticker';
            const sourceId = 'sourceId' in op ? op.sourceId : '';
            const image = await assets.image(source.guildId, kind, sourceId);
            return action.type === 'create-emoji'
                ? writer.createEmoji(guildId, { name: action.name, image })
                : writer.createSticker(guildId, { ...action, image });
        }
        case 'create-thread':
            return createThread(
                state,
                action,
                'sourceId' in op ? op.sourceId : ''
            );
        case 'link':
            return linkChannels(state, op);
        case 'delete':
            await deleteObject(state, op, destId);
            return null;
        default:
            return null;
    }
}

/** Performs the write. Returns the new ID for a create, else null. */
async function perform(
    state: RunState,
    action: Write,
    op: PlanOp
): Promise<string | null> {
    const { writer } = state.deps;
    const guildId = state.input.destination.guildId;
    const destId = 'destId' in op ? op.destId : '';
    switch (action.type) {
        case 'update-role':
        case 'archive-role':
            await writer.updateRole(guildId, destId, action.patch);
            return null;
        case 'update-channel':
            await writer.updateChannel(guildId, destId, action.patch);
            return null;
        case 'archive-channel': {
            const patch = action.move
                ? { ...action.patch, parentId: await archiveCategory(state) }
                : action.patch;
            await writer.updateChannel(guildId, destId, patch);
            return null;
        }
        case 'rename-guild':
            await writer.renameGuild(guildId, action.name);
            return null;
        case 'role-positions':
            await writer.setRolePositions(guildId, action.positions);
            return null;
        case 'channel-positions':
            await writer.setChannelPositions(guildId, action.positions);
            return null;
        case 'rename-emoji':
        case 'archive-emoji':
            await writer.renameEmoji(guildId, destId, action.name);
            return null;
        case 'update-sticker':
            await writer.updateSticker(guildId, destId, action.patch);
            return null;
        case 'archive-sticker':
            await writer.updateSticker(guildId, destId, { name: action.name });
            return null;
        case 'update-thread':
        case 'archive-thread':
            await writer.updateThread(guildId, destId, action.patch);
            return null;
        default:
            return performLifecycle(state, action, op, destId);
    }
}

/** After a removal, the row records how far the object has gone. */
async function recordRemoval(state: RunState, op: PlanOp): Promise<void> {
    if (op.op !== 'archive' && op.op !== 'hard-delete') return;
    const { plan } = state.input;
    const next: ObjectState = op.op === 'archive' ? 'archived' : 'tombstoned';
    const row = state.rows.find(
        (r) => r.kind === op.kind && destIdOf(r, plan.direction) === op.destId
    );
    if (!row)
        throw new Error(`${op.op} ${op.kind}: no map row for ${op.destId}`);
    await state.deps.store.setRowState(row.id, next, state.deps.now());
    state.rows = state.rows.map((r) =>
        r.id === row.id ? { ...r, state: next } : r
    );
    state.map = buildMap(state);
}

/** Records ownership and the written fields after a successful write. */
async function record(
    state: RunState,
    op: PlanOp,
    applied: Fields,
    newId: string | null
): Promise<void> {
    const { plan } = state.input;
    const { store, now } = state.deps;
    if (op.op !== 'create' && op.op !== 'update') return;
    const destId = op.op === 'create' ? newId : op.destId;
    if (!destId) throw new Error(`create ${op.kind} returned no ID`);
    const row = state.rows.find(
        (r) => r.kind === op.kind && destIdOf(r, plan.direction) === destId
    );
    if (row) {
        const fields = { ...(row.appliedFields ?? {}), ...applied };
        await store.saveApplied(row.id, fields, now());
        state.rows = state.rows.map((r) =>
            r.id === row.id ? { ...r, appliedFields: fields } : r
        );
    } else {
        const created = await store.insertMapping(
            {
                guildLinkId: plan.guildLinkId,
                kind: op.kind,
                ...pair(plan.direction, op.sourceId, destId),
                createdBySync: op.op === 'create',
                appliedFields: applied,
            },
            now()
        );
        state.rows = [...state.rows, created];
    }
    state.map = buildMap(state);
}

function auditFields(op: PlanOp, action: WriteAction): JsonValue {
    if (op.op === 'update') {
        return Object.fromEntries(op.changes.map((c) => [c.field, c.to]));
    }
    if (op.op === 'reorder') return [...op.destIds];
    return 'applied' in action ? action.applied : null;
}

/** The audit fields known before the write runs. */
function auditBase(plan: Plan, op: PlanOp) {
    return {
        planId: plan.id,
        guildLinkId: plan.guildLinkId,
        op: op.op,
        kind: op.kind,
        sourceId: 'sourceId' in op ? op.sourceId : null,
        before:
            op.op === 'update'
                ? Object.fromEntries(op.changes.map((c) => [c.field, c.from]))
                : null,
    };
}

/** Applies one op and reports what became of it. */
async function applyOp(
    state: RunState,
    op: PlanOp
): Promise<'written' | 'skipped' | 'failed'> {
    const { plan, source, destination } = state.input;
    const { store, now, logger } = state.deps;
    const ctx: WriteContext = {
        source,
        destination,
        map: state.map,
        direction: plan.direction,
    };
    const action = writeFor(op, ctx);
    if (action.type === 'skip') {
        state.skipped.push({ op, reason: action.reason });
        return 'skipped';
    }
    const entry = auditBase(plan, op);
    let newId: string | null;
    try {
        newId = await perform(state, action, op);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof NotReadyError) {
            state.skipped.push({ op, reason: detail });
            return 'skipped';
        }
        logger.warn(`[guild-sync] ${op.op} ${op.kind} failed: ${detail}`);
        await store.audit(
            {
                ...entry,
                destId: 'destId' in op ? op.destId : null,
                after: { error: detail },
                result: 'failed',
            },
            now()
        );
        return 'failed';
    }
    // A database error from here on is not caught: the write happened but
    // ownership was not recorded, so the add-ons must stop (guard 15).
    await store.audit(
        {
            ...entry,
            destId: 'destId' in op ? op.destId : newId,
            after: auditFields(op, action),
            result: 'ok',
        },
        now()
    );
    if ('applied' in action) await record(state, op, action.applied, newId);
    await recordRemoval(state, op);
    await state.deps.pause(pauseAfter(action, op.kind));
    return 'written';
}

/**
 * Gives @everyone and the server a map row once nothing is left to sync
 * for them, so a later edit on the destination counts as drift.
 */
async function recordBaselines(state: RunState): Promise<void> {
    const { plan, source, destination } = state.input;
    const pending = [...plan.body.ops, ...plan.body.deferred].filter(
        (op) => op.op === 'update' && op.baseline
    );
    const everyone = source.roles.find((r) => r.id === source.everyoneRoleId);
    const baselines: { kind: 'role' | 'guild'; applied: Fields }[] = [
        { kind: 'guild', applied: { name: source.name } },
    ];
    if (everyone) {
        const ctx = { map: state.map, direction: plan.direction };
        baselines.push({
            kind: 'role',
            applied: projectSourceRole(everyone, ctx),
        });
    }
    for (const baseline of baselines) {
        if (state.map.hasRow(baseline.kind, source.guildId)) continue;
        if (pending.some((op) => op.kind === baseline.kind)) continue;
        const created = await state.deps.store.insertMapping(
            {
                guildLinkId: plan.guildLinkId,
                kind: baseline.kind,
                ...pair(plan.direction, source.guildId, destination.guildId),
                createdBySync: false,
                appliedFields: baseline.applied,
            },
            state.deps.now()
        );
        state.rows = [...state.rows, created];
        state.map = buildMap(state);
    }
}

/**
 * Applies a plan's ops in order (design: Cycle step 7). A failed write is
 * recorded and the run goes on, up to MAX_FAILURES_PER_CYCLE. The next
 * cycle plans again from fresh snapshots, so nothing is retried blindly.
 */
export async function applyPlan(
    input: ApplyInput,
    deps: ApplyDeps
): Promise<ApplyResult> {
    const state: RunState = {
        input,
        deps,
        rows: [...input.rows],
        map: IdMap.from(
            input.rows,
            input.plan.direction,
            input.source,
            input.destination
        ),
        applied: 0,
        failed: 0,
        skipped: [],
        archiveCategoryId: null,
    };
    let stopped: string | null = null;
    for (const op of input.plan.body.ops) {
        if (!deps.canWrite()) {
            stopped = 'writes were switched off';
            break;
        }
        if (state.failed >= MAX_FAILURES_PER_CYCLE) {
            stopped = `${state.failed} writes failed`;
            break;
        }
        const outcome = await applyOp(state, op);
        if (outcome === 'written') state.applied += 1;
        else if (outcome === 'failed') state.failed += 1;
    }
    if (stopped === null && state.failed === 0) await recordBaselines(state);
    return {
        applied: state.applied,
        failed: state.failed,
        skipped: state.skipped,
        stopped,
    };
}

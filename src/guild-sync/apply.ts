import type { ObjectState, SyncDirection } from '../addons/db/schema';
import type { FailureLedger } from './failures';
import { UnrecordedWriteError, type AddonLogger } from '../addons/isolation';
import {
    INTENT_WINDOW_MS,
    latestIntent,
    madeAfter,
    type IntentKey,
} from './adopt';
import type { AssetSource } from './assets';
import { IdMap } from './idmap';
import { OwnershipLostError } from './cycleGuard';
import type { ChannelLinker, ThreadSource } from './links';
import type { JsonValue, MapRow, PlanOp } from './ops';
import { destIdOf, isRemoval } from './ops';
import type { Plan } from './plan';
import { MAX_CHANNELS_PER_CATEGORY } from './diff';
import { ORDER_PENDING } from './order';
import {
    botHeldBits,
    everyoneHidden,
    maxBitrateOf,
    projectSourceRole,
    projectSourceSettings,
    type Fields,
} from './project';
import { THREAD_ONLY_TYPES, type GuildSnapshot } from './snapshot';
import type { GuildSyncStore } from './store';
import {
    ARCHIVE_CATEGORY,
    LOCK_BITS,
    writeFor,
    type FollowUp,
    type WriteAction,
    type WriteContext,
} from './writes';
import type {
    ChannelSpec,
    GuildWriter,
    RolePatch,
    ThreadSpec,
} from './writers/writer';

/**
 * Pauses after a write, sized to Fluxer's per-guild route limits
 * (GuildRateLimitConfig.ts): 10 role or channel creates or deletes a
 * minute, 10 emoji or sticker creates or deletes in 30 seconds, and 20
 * updates in 10 seconds.
 */
export const SLOW_WRITE_MS = 6_500;
export const EXPRESSION_WRITE_MS = 3_200;
export const UPDATE_WRITE_MS = 1_000;

type Write = Exclude<WriteAction, { type: 'skip' } | { type: 'gone' }>;

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
        case 'adopt':
            return 0;
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

/** A cycle stops applying after this many failed writes in all. */
export const MAX_FAILURES_PER_CYCLE = 10;

/**
 * One kind stops after this many failed writes in a cycle, so a failing
 * kind (say, links the bot may not make) does not hold up the others.
 */
export const MAX_FAILURES_PER_KIND = 3;

export interface ApplyInput {
    readonly plan: Plan;
    readonly source: GuildSnapshot;
    readonly destination: GuildSnapshot;
    /** The object map the plan was built from. */
    readonly rows: readonly MapRow[];
    /** Linked accounts, source user ID to destination user ID. */
    readonly members?: ReadonlyMap<string, string>;
    /** Source channels locked while their history imports. */
    readonly historyLocked?: ReadonlySet<string>;
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
    /** Checked before every write: false once the leader lock is lost. */
    readonly stillLeader?: () => Promise<boolean>;
    /**
     * Checked before every write: why the link's own settings, read again,
     * no longer allow writes (its kill switch or mode changed during the
     * run), or null. A failed read stops the run too.
     */
    readonly writesStopped?: () => Promise<string | null>;
    /** Ops that keep failing wait out a backoff instead of every cycle. */
    readonly failures?: FailureLedger;
    readonly pause: (ms: number) => Promise<void>;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

export interface ApplyResult {
    readonly applied: number;
    readonly failed: number;
    readonly skipped: readonly { op: PlanOp; reason: string }[];
    /** Each failed write and why, in order. Bounded by the failure caps. */
    readonly failures: readonly { op: PlanOp; reason: string }[];
    /** Ops held back for the next cycle, which should come soon. */
    readonly postponed: number;
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
    /** Failed writes this cycle, by failure bucket (see bucketOf). */
    readonly failedByKind: Map<string, number>;
    readonly skipped: { op: PlanOp; reason: string }[];
    readonly failures: { op: PlanOp; reason: string }[];
    postponed: number;
    /** Kinds of position-holding objects this run created. */
    readonly created: Set<'role' | 'channel'>;
    /** Channels moved into each archive category this run. */
    readonly archiveMoves: Map<string, number>;
    /**
     * True while an @everyone update in the plan has not been written.
     * Channel creates wait for it (see everyoneGate).
     */
    everyonePending: boolean;
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

/** The applied-fields key that marks a map row as an archive category. */
export const ARCHIVE_KEY = 'archiveCategory';

/** The archive categories the map records, in number order. */
function archiveSlots(state: RunState): { id: string; number: number }[] {
    const { direction } = state.input.plan;
    const slots: { id: string; number: number }[] = [];
    for (const row of state.rows) {
        const number = row.appliedFields?.[ARCHIVE_KEY];
        const id = destIdOf(row, direction);
        if (row.kind !== 'category' || row.state !== 'active') continue;
        if (typeof number === 'number' && id) slots.push({ id, number });
    }
    return slots.sort((a, b) => a.number - b.number);
}

/** Channels in a category now, counting moves made earlier this run. */
function archiveFill(state: RunState, id: string): number {
    const { channels } = state.input.destination;
    const before = channels.filter((c) => c.parentId === id).length;
    return before + (state.archiveMoves.get(id) ?? 0);
}

/**
 * An archive category with room, found only through the map so a user's
 * own category of the same name is never used. Fluxer holds 50 channels
 * per category; a full one gets a numbered successor.
 */
async function archiveCategory(state: RunState): Promise<string> {
    const present = new Set(state.input.destination.channels.map((c) => c.id));
    const slots = archiveSlots(state);
    for (const slot of slots) {
        const exists = present.has(slot.id) || state.archiveMoves.has(slot.id);
        if (!exists) continue;
        if (archiveFill(state, slot.id) < MAX_CHANNELS_PER_CATEGORY) {
            return slot.id;
        }
    }
    const number = slots.reduce((max, s) => Math.max(max, s.number), 0) + 1;
    return newArchiveCategory(state, number);
}

/** The name of archive category `number`. */
function archiveName(number: number): string {
    return number === 1 ? ARCHIVE_CATEGORY : `${ARCHIVE_CATEGORY}-${number}`;
}

/** The intent key of archive category `number`; no source object has one. */
function archiveIntentKey(number: number): IntentKey {
    return {
        kind: 'category',
        sourceId: `${ARCHIVE_KEY}:${number}`,
        name: archiveName(number),
    };
}

/** A category locked for @everyone. */
function archiveSpec(name: string, everyoneRoleId: string): ChannelSpec {
    return {
        type: CATEGORY_TYPE,
        name,
        parentId: null,
        topic: null,
        nsfw: false,
        rateLimitPerUser: 0,
        bitrate: null,
        userLimit: null,
        tags: [],
        overwrites: [
            {
                id: everyoneRoleId,
                type: 0,
                allow: '0',
                deny: LOCK_BITS.toString(),
            },
        ],
    };
}

/** Records the bot's ownership of archive category `number`. */
async function ownArchive(
    state: RunState,
    id: string,
    number: number
): Promise<string> {
    const { plan } = state.input;
    const toFluxer = plan.direction === 'discord-to-fluxer';
    const row = await state.deps.store.insertMapping(
        {
            guildLinkId: plan.guildLinkId,
            kind: 'category',
            discordId: toFluxer ? null : id,
            fluxerId: toFluxer ? id : null,
            createdBySync: true,
            appliedFields: { [ARCHIVE_KEY]: number, name: archiveName(number) },
        },
        state.deps.now()
    );
    state.rows = [...state.rows, row];
    state.archiveMoves.set(id, 0);
    return id;
}

/**
 * Archive category `number` made by an earlier create that timed out or
 * was never recorded: an unmapped category of its name, made after its
 * intent (adopt.ts). Null when there is none.
 */
async function orphanArchive(
    state: RunState,
    number: number
): Promise<string | null> {
    const { plan, destination } = state.input;
    const { store, now } = state.deps;
    const since = new Date(now().getTime() - INTENT_WINDOW_MS);
    const key = archiveIntentKey(number);
    const intents = await store.createIntents(plan.guildLinkId, since);
    const intent = latestIntent(intents, key);
    if (!intent) return null;
    const mapped = new Set(state.rows.map((r) => destIdOf(r, plan.direction)));
    const match = destination.channels.find(
        (c) =>
            c.type === CATEGORY_TYPE &&
            c.name === key.name &&
            !mapped.has(c.id) &&
            madeAfter(c.id, intent)
    );
    return match?.id ?? null;
}

/**
 * Archive category `number`: an earlier create's orphan when there is
 * one, else a new category, locked for @everyone and owned. A new one
 * that cannot be recorded stops the add-ons (guard 15).
 */
async function newArchiveCategory(
    state: RunState,
    number: number
): Promise<string> {
    const orphan = await orphanArchive(state, number);
    if (orphan) {
        state.deps.logger.info(
            `[guild-sync] Adopting archive category ${orphan}, made by an earlier create`
        );
        return ownArchive(state, orphan, number);
    }
    const { destination } = state.input;
    const key = archiveIntentKey(number);
    const spec = archiveSpec(key.name, destination.everyoneRoleId);
    const id = await sendCreate(state, key, () =>
        state.deps.writer.createChannel(destination.guildId, spec)
    );
    try {
        return await ownArchive(state, id, number);
    } catch (error) {
        throw new OwnershipLostError(
            `archive category ${id} was created but not recorded`,
            error
        );
    }
}

const CATEGORY_TYPE = 4;

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

type CreateThread = Extract<Write, { type: 'create-thread' }>;

/**
 * A forum post's first message and the webhook that posts it, or nulls
 * for a thread. Throws NotReadyError while the forum is not bridged.
 */
async function postStarter(
    state: RunState,
    action: CreateThread,
    sourceId: string
): Promise<Pick<ThreadSpec, 'starter' | 'webhook'>> {
    if (!THREAD_ONLY_TYPES.has(action.parentType)) {
        return { starter: null, webhook: null };
    }
    const { plan, source } = state.input;
    const { links, threads } = state.deps;
    const toFluxer = plan.direction === 'discord-to-fluxer';
    const link = toFluxer
        ? await links?.byDiscordChannel(action.parentSourceId)
        : await links?.byFluxerChannel(action.parentSourceId);
    if (!link || !threads) {
        throw new NotReadyError('the forum is not linked yet');
    }
    return {
        webhook: toFluxer ? link.fluxerWebhook : link.discordWebhook,
        starter: await threads.starter(source.guildId, sourceId),
    };
}

/** Creates a thread, or a forum post with its first message. */
async function createThread(
    state: RunState,
    action: CreateThread,
    op: PlanOp
): Promise<string> {
    const sourceId = 'sourceId' in op ? op.sourceId : '';
    const post = await postStarter(state, action, sourceId);
    const spec: ThreadSpec = {
        parentId: action.parentId,
        parentType: action.parentType,
        name: action.name,
        tags: action.tags,
        ...post,
        private: action.private,
        invitable: action.invitable,
        members: action.private
            ? await privateMembers(state, sourceId)
            : undefined,
    };
    const guildId = state.input.destination.guildId;
    return sendCreate(state, intentKey(op, action.name), () =>
        state.deps.writer.createThread(guildId, spec)
    );
}

/** Destination accounts of the linked members of a private source thread. */
async function privateMembers(
    state: RunState,
    sourceId: string
): Promise<string[]> {
    const { threads } = state.deps;
    const linked = state.input.members;
    if (!threads?.members) return [];
    // Called even with nobody linked: reading the members also has the
    // bot join the thread, so the relay receives its messages.
    const ids = await threads.members(state.input.source.guildId, sourceId);
    return ids.flatMap((id) => {
        const dest = linked?.get(id);
        return dest ? [dest] : [];
    });
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

/** Creates an emoji or sticker from the source image. */
async function createExpression(
    state: RunState,
    action: Extract<Write, { type: 'create-emoji' | 'create-sticker' }>,
    op: PlanOp
): Promise<string> {
    const { writer, assets } = state.deps;
    const sourceGuild = state.input.source.guildId;
    const guildId = state.input.destination.guildId;
    const kind = action.type === 'create-emoji' ? 'emoji' : 'sticker';
    const sourceId = 'sourceId' in op ? op.sourceId : '';
    const image = await assets.image(sourceGuild, kind, sourceId);
    return sendCreate(state, intentKey(op, action.name), () =>
        action.type === 'create-emoji'
            ? writer.createEmoji(guildId, { name: action.name, image })
            : writer.createSticker(guildId, { ...action, image })
    );
}

/** Creates and removals. Returns the new ID for a create, else null. */
async function performLifecycle(
    state: RunState,
    action: Write,
    op: PlanOp,
    destId: string
): Promise<string | null> {
    const { writer } = state.deps;
    const guildId = state.input.destination.guildId;
    switch (action.type) {
        case 'create-role':
            return sendCreate(state, intentKey(op, action.spec.name), () =>
                writer.createRole(guildId, action.spec)
            );
        case 'create-channel':
            return sendCreate(state, intentKey(op, action.spec.name), () =>
                writer.createChannel(guildId, action.spec)
            );
        case 'create-emoji':
        case 'create-sticker':
            return createExpression(state, action, op);
        case 'create-thread':
            return createThread(state, action, op);
        case 'link':
            return linkChannels(state, op);
        case 'adopt':
            return action.destId;
        case 'delete':
            await deleteObject(state, op, destId);
            return null;
        default:
            return null;
    }
}

/**
 * Swaps the source icon hash in a role patch for the image itself. Role
 * icon hashes differ across platforms, so only the image can be copied.
 */
async function withRoleIcon(
    state: RunState,
    patch: RolePatch,
    op: PlanOp
): Promise<RolePatch> {
    if (typeof patch.icon !== 'string' || !('sourceId' in op)) return patch;
    const image = await state.deps.assets.image(
        state.input.source.guildId,
        'role-icon',
        op.sourceId
    );
    return { ...patch, icon: image };
}

/** Locks a channel and, unless it is a category, moves it to the archive. */
async function archiveChannel(
    state: RunState,
    action: Extract<Write, { type: 'archive-channel' }>,
    destId: string
): Promise<void> {
    const { writer } = state.deps;
    const guildId = state.input.destination.guildId;
    if (!action.move) {
        await writer.updateChannel(guildId, destId, action.patch);
        return;
    }
    const parentId = await archiveCategory(state);
    await writer.updateChannel(guildId, destId, { ...action.patch, parentId });
    state.archiveMoves.set(
        parentId,
        (state.archiveMoves.get(parentId) ?? 0) + 1
    );
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
            await writer.updateRole(
                guildId,
                destId,
                await withRoleIcon(state, action.patch, op)
            );
            return null;
        case 'archive-role':
            await writer.updateRole(guildId, destId, action.patch);
            return null;
        case 'update-channel':
            await writer.updateChannel(guildId, destId, action.patch);
            return null;
        case 'archive-channel':
            await archiveChannel(state, action, destId);
            return null;
        case 'update-guild':
            await writer.updateGuild(guildId, action.patch);
            return null;
        case 'role-positions':
            await writer.setRolePositions(guildId, action.positions);
            return null;
        case 'channel-positions':
            await writer.setChannelPositions(guildId, action.moves);
            return null;
        case 'rename-emoji':
        case 'archive-emoji':
            await writer.renameEmoji(guildId, destId, action.name);
            return null;
        case 'update-sticker':
            await writer.updateSticker(guildId, destId, action.patch);
            return null;
        case 'archive-sticker':
            await writer.updateSticker(guildId, destId, action.patch);
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
async function recordRemoval(
    state: RunState,
    op: PlanOp,
    gone = false
): Promise<void> {
    if (op.op !== 'archive' && op.op !== 'hard-delete') return;
    const { plan } = state.input;
    // An object found already deleted needs no grace period.
    const next: ObjectState =
        op.op === 'archive' && !gone ? 'archived' : 'tombstoned';
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

/** Merges fields into a mapped object's base. Returns false without a row. */
async function saveFields(
    state: RunState,
    kind: PlanOp['kind'],
    destId: string,
    fields: Fields,
    drop: readonly string[] = []
): Promise<boolean> {
    const { direction } = state.input.plan;
    const row = state.rows.find(
        (r) => r.kind === kind && destIdOf(r, direction) === destId
    );
    if (!row) return false;
    const merged: Record<string, JsonValue> = {
        ...(row.appliedFields ?? {}),
        ...fields,
    };
    for (const field of drop) delete merged[field];
    await state.deps.store.saveApplied(row.id, merged, state.deps.now());
    state.rows = state.rows.map((r) =>
        r.id === row.id ? { ...r, appliedFields: merged } : r
    );
    state.map = buildMap(state);
    return true;
}

/** Kinds whose new objects still need a place in the order. */
const ORDERED_KINDS: ReadonlySet<string> = new Set([
    'role',
    'category',
    'channel',
]);

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
    if (await saveFields(state, op.kind, destId, applied)) return;
    // A new object lands wherever the platform puts it. The flag makes the
    // next order diff move it, rather than call the mismatch drift.
    const pending = op.op === 'create' && ORDERED_KINDS.has(op.kind);
    const created = await store.insertMapping(
        {
            guildLinkId: plan.guildLinkId,
            kind: op.kind,
            ...pair(plan.direction, op.sourceId, destId),
            createdBySync: op.op === 'create',
            appliedFields: pending
                ? { ...applied, [ORDER_PENDING]: true }
                : applied,
        },
        now()
    );
    state.rows = [...state.rows, created];
    state.map = buildMap(state);
    if (pending) state.created.add(op.kind === 'role' ? 'role' : 'channel');
}

/**
 * A channel that changed parent this run sits elsewhere than the snapshot
 * says, so channel positions wait for the next cycle's fresh read.
 */
function noteMoves(state: RunState, op: PlanOp): void {
    if (op.op !== 'update' || (op.kind !== 'channel' && op.kind !== 'category'))
        return;
    if (op.changes.some((c) => c.field === 'parentId')) {
        state.created.add('channel');
    }
}

/** After a reorder, the objects it placed are no longer pending. */
async function settleOrder(
    state: RunState,
    op: PlanOp,
    action: WriteAction
): Promise<void> {
    if (op.op !== 'reorder') return;
    const kinds = op.kind === 'role' ? ['role'] : ['category', 'channel'];
    const placed =
        action.type === 'channel-positions' ? action.placed : op.destIds;
    for (const destId of placed) {
        const row = state.rows.find(
            (r) =>
                kinds.includes(r.kind) &&
                destIdOf(r, state.input.plan.direction) === destId
        );
        if (!row?.appliedFields?.[ORDER_PENDING]) continue;
        await saveFields(state, row.kind as PlanOp['kind'], destId, {}, [
            ORDER_PENDING,
        ]);
    }
}

function auditFields(op: PlanOp, action: WriteAction): JsonValue {
    if (op.op === 'update') {
        return Object.fromEntries(op.changes.map((c) => [c.field, c.to]));
    }
    if (op.op === 'reorder') return [...op.destIds];
    if (action.type === 'gone') return { gone: true };
    if (action.type === 'adopt') return { adopted: true };
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

/** Fluxer and Discord both answer 404 for an object that is gone. */
export function isNotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const { status, statusCode } = error as {
        status?: unknown;
        statusCode?: unknown;
    };
    return status === 404 || statusCode === 404;
}

/** The HTTP status an error carries, or null. */
function httpStatus(error: unknown): number | null {
    if (typeof error !== 'object' || error === null) return null;
    const { status, statusCode } = error as {
        status?: unknown;
        statusCode?: unknown;
    };
    if (typeof status === 'number') return status;
    return typeof statusCode === 'number' ? statusCode : null;
}

/**
 * True when the platform answered with a refusal (4xx), so it made
 * nothing. A timeout, a network error or a server error leaves the
 * outcome unclear: the object may exist.
 */
export function isRefused(error: unknown): boolean {
    const status = httpStatus(error);
    if (status === null || status === 408) return false;
    return status >= 400 && status < 500;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The ledger key for one op: the same op on the same object. */
function opKey(plan: Plan, op: PlanOp): string {
    const target = 'sourceId' in op ? op.sourceId : op.scope;
    return `${plan.guildLinkId}:${op.op}:${op.kind}:${target}`;
}

/** True for an update of the destination @everyone role. */
function isEveryoneUpdate(op: PlanOp, everyoneId: string): boolean {
    return op.op === 'update' && op.kind === 'role' && op.destId === everyoneId;
}

/**
 * Channels are created only once @everyone's permissions are synced. A
 * Discord channel kept private by @everyone's own permissions, with no
 * overwrite of its own, would otherwise appear open on Fluxer.
 */
function everyoneGate(state: RunState, op: PlanOp): string | null {
    if (!state.everyonePending || op.op !== 'create') return null;
    if (op.kind !== 'category' && op.kind !== 'channel') return null;
    return 'waits for the @everyone permission sync to succeed';
}

/** Why an op waits for a later cycle, or null. */
function holdReason(state: RunState, op: PlanOp): string | null {
    const gate = everyoneGate(state, op);
    if (gate) return gate;
    const { failures, now } = state.deps;
    if (failures?.blocked(opKey(state.input.plan, op), now())) {
        return 'failed repeatedly; retried after a backoff';
    }
    // Positions read before this run's creates are stale once Fluxer moved
    // objects to make room. The next cycle reads them fresh.
    if (op.op === 'reorder' && state.created.has(op.kind)) {
        state.postponed += 1;
        return 'objects were created this run; reordered next cycle';
    }
    return null;
}

type Attempt =
    | { readonly ok: true; readonly newId: string | null; gone: boolean }
    | { readonly ok: false; readonly detail: string; notReady: boolean };

/** Runs the write. A removal of an object already gone counts as done. */
async function attempt(
    state: RunState,
    action: Write,
    op: PlanOp
): Promise<Attempt> {
    try {
        return {
            ok: true,
            newId: await perform(state, action, op),
            gone: false,
        };
    } catch (error) {
        // A write that went through but could not be recorded must reach
        // the isolation boundary, which trips read-only (guard 15).
        if (
            error instanceof OwnershipLostError ||
            error instanceof UnrecordedWriteError
        ) {
            throw error;
        }
        if (isRemoval(op) && isNotFound(error)) {
            return { ok: true, newId: null, gone: true };
        }
        return {
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
            notReady: error instanceof NotReadyError,
        };
    }
}

async function auditFailure(
    state: RunState,
    op: PlanOp,
    detail: string
): Promise<void> {
    const { plan } = state.input;
    const { store, now, logger, failures } = state.deps;
    logger.warn(`[guild-sync] ${op.op} ${op.kind} failed: ${detail}`);
    state.failures.push({ op, reason: detail });
    failures?.failed(opKey(plan, op), now());
    await store.audit(
        {
            ...auditBase(plan, op),
            destId: 'destId' in op ? op.destId : null,
            after: { error: detail },
            result: 'failed',
        },
        now()
    );
}

/** Sends a create's second write. Its fields join the base on success. */
async function followUp(
    state: RunState,
    op: PlanOp,
    next: FollowUp,
    destId: string
): Promise<boolean> {
    const { writer } = state.deps;
    const guildId = state.input.destination.guildId;
    try {
        if (next.type === 'role') {
            await writer.updateRole(guildId, destId, next.patch);
        } else await writer.updateThread(guildId, destId, next.patch);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await auditFailure(state, op, `follow-up: ${detail}`);
        return false;
    }
    await saveFields(state, op.kind, destId, next.fields);
    return true;
}

/** The intent key of a create op. */
function intentKey(op: PlanOp, name: string): IntentKey {
    return {
        kind: op.kind,
        sourceId: 'sourceId' in op ? op.sourceId : '',
        name,
    };
}

/** Writes a create-intent audit row: an intent, or a refusal after one. */
async function auditIntent(
    state: RunState,
    key: IntentKey,
    result: 'intent' | 'refused'
): Promise<void> {
    const { plan } = state.input;
    await state.deps.store.audit(
        {
            planId: plan.id,
            guildLinkId: plan.guildLinkId,
            op: 'create-intent',
            kind: key.kind,
            sourceId: key.sourceId,
            destId: null,
            before: null,
            after:
                result === 'refused'
                    ? { name: key.name, refused: true }
                    : { name: key.name },
            result,
        },
        state.deps.now()
    );
}

/** Records a refusal. Without it, the intent stays usable as after a timeout. */
async function recordRefusal(state: RunState, key: IntentKey): Promise<void> {
    try {
        await auditIntent(state, key, 'refused');
    } catch (error) {
        state.deps.logger.warn(
            `[guild-sync] create ${key.kind} refusal not recorded: ${messageOf(error)}`
        );
    }
}

/**
 * Sends one create. Its intent is recorded right before the platform
 * call, after every check that could stop it, so an intent always stands
 * for a create that was sent. If the create then times out after the
 * platform made the object, or the process stops before the map row is
 * saved, a later cycle adopts the object instead of skipping it forever
 * or making a duplicate (adopt.ts). A create the platform refused gets a
 * refusal after its intent, so a person's later object of the same name
 * is never adopted on it.
 */
async function sendCreate(
    state: RunState,
    key: IntentKey,
    send: () => Promise<string>
): Promise<string> {
    await auditIntent(state, key, 'intent');
    try {
        return await send();
    } catch (error) {
        if (isRefused(error)) await recordRefusal(state, key);
        throw error;
    }
}

/** Audit, ownership and removal state for a write that went through. */
async function recordOutcome(
    state: RunState,
    op: PlanOp,
    action: Exclude<WriteAction, { type: 'skip' }>,
    result: Extract<Attempt, { ok: true }>
): Promise<void> {
    const { plan } = state.input;
    const { store, now } = state.deps;
    await store.audit(
        {
            ...auditBase(plan, op),
            destId: 'destId' in op ? op.destId : result.newId,
            after: result.gone ? { gone: true } : auditFields(op, action),
            result: 'ok',
        },
        now()
    );
    if ('applied' in action) {
        await record(state, op, action.applied, result.newId);
    }
    await recordRemoval(state, op, result.gone || action.type === 'gone');
    await settleOrder(state, op, action);
}

/**
 * Records a write that went through. A failure to record it means the
 * bot may own an object the map does not know of: that is the one case
 * that must stop the add-ons (guard 15, see cycleGuard.ts).
 */
async function recordWrite(
    state: RunState,
    op: PlanOp,
    action: Exclude<WriteAction, { type: 'skip' }>,
    result: Extract<Attempt, { ok: true }>
): Promise<'written' | 'failed'> {
    state.deps.failures?.succeeded(opKey(state.input.plan, op));
    try {
        await recordOutcome(state, op, action, result);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new OwnershipLostError(
            `${op.op} ${op.kind} was written but not recorded: ${detail}`,
            error
        );
    }
    noteMoves(state, op);
    if (isEveryoneUpdate(op, state.input.destination.everyoneRoleId)) {
        state.everyonePending = false;
    }
    const next = 'followUp' in action ? action.followUp : null;
    if (next && result.newId) {
        await state.deps.pause(UPDATE_WRITE_MS);
        if (!(await followUp(state, op, next, result.newId))) return 'failed';
    }
    return 'written';
}

/** Applies one op and reports what became of it. */
async function applyOp(
    state: RunState,
    op: PlanOp
): Promise<'written' | 'skipped' | 'failed'> {
    const { plan, source, destination } = state.input;
    const ctx: WriteContext = {
        source,
        destination,
        map: state.map,
        direction: plan.direction,
        members: state.input.members,
        hiddenFromEveryone: everyoneHidden(source, plan.direction),
        maxBitrate: maxBitrateOf(destination),
        historyLocked: state.input.historyLocked,
    };
    const action = writeFor(op, ctx);
    const held = action.type === 'skip' ? action.reason : holdReason(state, op);
    if (held !== null || action.type === 'skip') {
        state.skipped.push({ op, reason: held ?? 'skipped' });
        return 'skipped';
    }
    if (action.type === 'gone') {
        return recordWrite(state, op, action, {
            ok: true,
            newId: null,
            gone: true,
        });
    }
    const result = await attempt(state, action, op);
    if (!result.ok) {
        if (result.notReady) {
            state.skipped.push({ op, reason: result.detail });
            return 'skipped';
        }
        await auditFailure(state, op, result.detail);
        return 'failed';
    }
    const outcome = await recordWrite(state, op, action, result);
    await state.deps.pause(pauseAfter(action, op.kind));
    return outcome;
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
    const ctx = {
        map: state.map,
        direction: plan.direction,
        everyoneMask: botHeldBits(destination) ?? undefined,
    };
    const baselines: { kind: 'role' | 'guild'; applied: Fields }[] = [
        {
            kind: 'guild',
            applied: {
                name: source.name,
                ...projectSourceSettings(source.settings, ctx),
            },
        },
    ];
    if (everyone) {
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
 * The failure cap bucket of an op. Reorders count apart from the other
 * writes of their kind, so a refused reorder cannot hold up links.
 */
export function bucketOf(op: PlanOp): string {
    return op.op === 'reorder' ? `reorder:${op.kind}` : op.kind;
}

/** Why the link's settings, read again, stop the run, or null. */
async function settingsStop(state: RunState): Promise<string | null> {
    const { writesStopped } = state.deps;
    if (!writesStopped) return null;
    try {
        return await writesStopped();
    } catch (error) {
        return `link settings could not be read again: ${messageOf(error)}`;
    }
}

/** Why the run must stop before the next op, or null. */
async function stopReason(state: RunState): Promise<string | null> {
    if (!state.deps.canWrite()) return 'writes were switched off';
    const stopped = await settingsStop(state);
    if (stopped !== null) return stopped;
    if (state.failed >= MAX_FAILURES_PER_CYCLE) {
        return `${state.failed} writes failed`;
    }
    const { stillLeader } = state.deps;
    if (stillLeader && !(await stillLeader())) {
        return 'the leader lock was lost';
    }
    return null;
}

function newState(input: ApplyInput, deps: ApplyDeps): RunState {
    return {
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
        failedByKind: new Map(),
        skipped: [],
        failures: [],
        postponed: 0,
        created: new Set(),
        archiveMoves: new Map(),
        everyonePending: [
            ...input.plan.body.ops,
            ...input.plan.body.deferred,
        ].some((op) => isEveryoneUpdate(op, input.destination.everyoneRoleId)),
    };
}

/**
 * Applies a plan's ops in order (design: Cycle step 7). A failed write is
 * recorded and the run goes on, up to MAX_FAILURES_PER_KIND for one kind
 * and MAX_FAILURES_PER_CYCLE in all. The next cycle plans again from fresh
 * snapshots, and an op that keeps failing waits out a backoff.
 */
export async function applyPlan(
    input: ApplyInput,
    deps: ApplyDeps
): Promise<ApplyResult> {
    const state = newState(input, deps);
    let stopped: string | null = null;
    for (const op of input.plan.body.ops) {
        stopped = await stopReason(state);
        if (stopped !== null) break;
        const bucket = bucketOf(op);
        const kindFailures = state.failedByKind.get(bucket) ?? 0;
        if (kindFailures >= MAX_FAILURES_PER_KIND) {
            state.skipped.push({
                op,
                reason: `${kindFailures} ${bucket} writes failed this cycle`,
            });
            continue;
        }
        const outcome = await applyOp(state, op);
        if (outcome === 'written') state.applied += 1;
        else if (outcome === 'failed') {
            state.failed += 1;
            state.failedByKind.set(bucket, kindFailures + 1);
        }
    }
    if (stopped === null && state.failed === 0) await recordBaselines(state);
    return {
        applied: state.applied,
        failed: state.failed,
        skipped: state.skipped,
        failures: state.failures,
        postponed: state.postponed,
        stopped,
    };
}

import type { SyncDirection } from '../addons/db/schema';
import type { AddonLogger } from '../addons/isolation';
import type { AddonMode } from '../addons/config';
import { applyPlan, type ApplyResult } from './apply';
import type { AssetSource } from './assets';
import { diff, type DiffInput } from './diff';
import {
    applyMissing,
    checkDeleteBudget,
    enforceOwnership,
    orderAndCap,
    planRemovals,
    removalCandidates,
    trackMissing,
} from './guards';
import { checkShrink, checkSourceHealth } from './health';
import { IdMap } from './idmap';
import type { ChannelLinker, ThreadSource } from './links';
import {
    applyNotice,
    planFingerprint,
    planNotice,
    type NoticeBoard,
} from './notices';
import type { Finding, MapRow } from './ops';
import { sourceIdOf } from './ops';
import { EMPTY_BODY, summarizePlan, type Plan, type PlanBody } from './plan';
import type { GuildReader } from './readers/reader';
import type { GuildSnapshot } from './snapshot';
import { countObjects, stableJson } from './snapshot';
import type { GuildSyncStore, SyncSettings } from './store';
import type { GuildWriter } from './writers/writer';

/** The upstream guild link a cycle syncs. */
export interface LinkedGuild {
    readonly id: string;
    readonly discordGuildId: string;
    readonly fluxerGuildId: string;
}

export interface CycleDeps {
    readonly store: GuildSyncStore;
    readonly readers: {
        readonly discord: GuildReader;
        readonly fluxer: GuildReader;
    };
    /** Destination writers. A side without one is never written to. */
    readonly writers: {
        readonly discord?: GuildWriter;
        readonly fluxer?: GuildWriter;
    };
    /** Emoji and sticker images, by the side they are read from. */
    readonly assets: {
        readonly discord?: AssetSource;
        readonly fluxer?: AssetSource;
    };
    /** Bifröst's channel links, or null when the relay is not wired in. */
    readonly links: ChannelLinker | null;
    /**
     * With history import on: Discord channels whose history is copied and
     * may be bridged. Undefined when history import is off.
     */
    readonly historyReady?: (linkId: string) => Promise<ReadonlySet<string>>;
    /** First messages of threads and posts, by the side they are read from. */
    readonly threadSources: {
        readonly discord?: ThreadSource;
        readonly fluxer?: ThreadSource;
    };
    /** Posts plans and results to the link's admin channel. */
    readonly notices: NoticeBoard;
    /** The command prefix, for the approval hint in a notice. */
    readonly commandPrefix: string;
    /** The process-wide add-on mode (guards 9 and 15). */
    readonly processMode: () => AddonMode;
    /** BF_ADDONS_ALLOW_APPLY: whether any link may be in apply mode. */
    readonly allowApply: boolean;
    readonly pause: (ms: number) => Promise<void>;
    readonly logger: AddonLogger;
    readonly now: () => Date;
    readonly newId: () => string;
}

export type CycleOutcome =
    | { readonly status: 'skipped'; readonly reason: string }
    | {
          readonly status: 'planned';
          readonly plan: Plan;
          /** Set when the plan was applied, fully or in part. */
          readonly applied?: ApplyResult;
          /** True when writes went through and more ops are waiting. */
          readonly more: boolean;
      };

/** Direct lookups per cycle for guard 4. The rest wait for a later cycle. */
export const MAX_LOOKUPS_PER_CYCLE = 20;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The mode one cycle runs in. Read-only wins from any source. Apply needs
 * two switches: the environment allows it (BF_ADDONS_ALLOW_APPLY) and an
 * admin set the link to apply. Anything else plans without writing.
 */
export function resolveMode(
    processMode: AddonMode,
    settings: SyncSettings,
    allowApply = false
): { mode: 'read-only' | 'dry-run' | 'apply'; reason: string | null } {
    if (settings.killSwitch)
        return { mode: 'read-only', reason: 'kill switch is on' };
    if (processMode === 'read-only')
        return { mode: 'read-only', reason: 'add-ons are read-only' };
    if (settings.mode === 'read-only')
        return { mode: 'read-only', reason: 'link is read-only' };
    if (settings.mode === 'apply' && allowApply)
        return { mode: 'apply', reason: null };
    return { mode: 'dry-run', reason: null };
}

function sides(link: LinkedGuild, direction: SyncDirection) {
    const discordToFluxer = direction === 'discord-to-fluxer';
    return {
        source: discordToFluxer ? ('discord' as const) : ('fluxer' as const),
        dest: discordToFluxer ? ('fluxer' as const) : ('discord' as const),
        sourceGuildId: discordToFluxer
            ? link.discordGuildId
            : link.fluxerGuildId,
        destGuildId: discordToFluxer ? link.fluxerGuildId : link.discordGuildId,
    };
}

type GateOutcome =
    | {
          ok: true;
          source: GuildSnapshot;
          destination: GuildSnapshot;
          lastHealthy: GuildSnapshot | null;
      }
    | { ok: false; reason: string; needsApproval: boolean };

/** Reads both sides and runs guards 2 and 3. Nothing is diffed on failure. */
async function readAndGate(
    link: LinkedGuild,
    settings: SyncSettings,
    deps: CycleDeps,
    takenAt: Date,
    approved: Plan | null
): Promise<GateOutcome> {
    const s = sides(link, settings.direction);
    const gate = checkSourceHealth(
        await deps.readers[s.source].read(s.sourceGuildId)
    );
    if (!gate.ok)
        return { ok: false, reason: gate.reason, needsApproval: false };
    const lastHealthy = await deps.store.lastSnapshot(link.id, s.source, true);
    const shrink = checkShrink(
        gate.snapshot,
        lastHealthy ? countObjects(lastHealthy) : null,
        settings
    );
    const shrinkReason = shrink.ok ? null : `shrink check: ${shrink.reason}`;
    // Guard 3 needs a person. Until an admin approves this exact shrink,
    // the last healthy snapshot stays as it was and every cycle aborts the
    // same way. Once approved, the smaller source becomes the new baseline.
    if (shrinkReason !== null && approved?.abortReason !== shrinkReason) {
        await deps.store.saveSnapshot(link.id, gate.snapshot, false, takenAt);
        return { ok: false, reason: shrinkReason, needsApproval: true };
    }
    const destRead = await deps.readers[s.dest].read(s.destGuildId);
    if (!destRead.ok) {
        return {
            ok: false,
            reason: `destination ${destRead.reason}: ${destRead.detail}`,
            needsApproval: false,
        };
    }
    return {
        ok: true,
        source: gate.snapshot,
        destination: destRead.snapshot,
        lastHealthy,
    };
}

/** Saves a snapshot unless it matches the last one saved for that side. */
async function saveIfChanged(
    store: GuildSyncStore,
    linkId: string,
    snapshot: GuildSnapshot,
    takenAt: Date
): Promise<void> {
    const last = await store.lastSnapshot(linkId, snapshot.side, true);
    if (last && stableJson(last) === stableJson(snapshot)) return;
    await store.saveSnapshot(linkId, snapshot, true, takenAt);
}

/** Runs guard 4's direct lookups for up to MAX_LOOKUPS_PER_CYCLE rows. */
async function confirmGone(
    candidates: readonly MapRow[],
    reader: GuildReader,
    guildId: string,
    direction: SyncDirection
): Promise<Set<string>> {
    const gone = new Set<string>();
    for (const row of candidates.slice(0, MAX_LOOKUPS_PER_CYCLE)) {
        const sourceId = sourceIdOf(row, direction);
        if (!sourceId || row.kind === 'overwrite') continue;
        if ((await reader.isGone(guildId, row.kind, sourceId)) === true)
            gone.add(row.id);
    }
    return gone;
}

function protectedIds(destination: GuildSnapshot): Set<string> {
    return new Set([
        destination.guildId,
        destination.everyoneRoleId,
        ...(destination.bot?.roleIds ?? []),
    ]);
}

/** Guards 4 to 6: removal ops for rows a direct lookup confirmed gone. */
async function confirmedRemovals(
    link: LinkedGuild,
    settings: SyncSettings,
    rows: readonly MapRow[],
    deps: CycleDeps,
    now: Date
) {
    const { direction } = settings;
    const candidates = removalCandidates(rows, settings, now);
    const s = sides(link, direction);
    const gone = await confirmGone(
        candidates,
        deps.readers[s.source],
        s.sourceGuildId,
        direction
    );
    return planRemovals(
        candidates.slice(0, MAX_LOOKUPS_PER_CYCLE),
        gone,
        direction,
        settings,
        now
    );
}

/**
 * Which channels the relay bridges already, and which never may be: the
 * admin channel, so its notices are not copied to the other server. Links
 * are planned only from Discord, where upstream's link service is keyed.
 */
async function linkState(
    link: LinkedGuild,
    settings: SyncSettings,
    deps: CycleDeps
): Promise<DiffInput['links']> {
    if (!deps.links || settings.direction !== 'discord-to-fluxer') {
        return undefined;
    }
    return {
        linked: await deps.links.linkedDiscordChannels(link.discordGuildId),
        never: new Set(
            settings.adminChannelId ? [settings.adminChannelId] : []
        ),
        historyReady: deps.historyReady
            ? await deps.historyReady(link.id)
            : undefined,
    };
}

/** Diff plus guards 1, 4 to 7 and 14, in that order. */
async function buildBody(
    link: LinkedGuild,
    settings: SyncSettings,
    gated: Extract<GateOutcome, { ok: true }>,
    deps: CycleDeps,
    now: Date
): Promise<{ body: PlanBody; rows: MapRow[] }> {
    const { direction } = settings;
    const { source, destination } = gated;
    const loaded = await deps.store.loadObjectMap(link.id);
    const missing = trackMissing(loaded, source, direction, now);
    await deps.store.saveMissing(missing, now);
    const rows = applyMissing(loaded, missing);

    const found = diff({
        source,
        destination,
        previousSource: gated.lastHealthy,
        rows,
        direction,
        links: await linkState(link, settings, deps),
    });
    const removals = await confirmedRemovals(link, settings, rows, deps, now);

    const map = IdMap.from(rows, direction, source, destination);
    const owned = enforceOwnership(
        [...found.ops, ...removals.ops],
        map,
        protectedIds(destination)
    );
    const removalsToday = await deps.store.removalsSince(
        link.id,
        new Date(now.getTime() - DAY_MS)
    );
    const budget = checkDeleteBudget(owned.kept, settings, removalsToday);
    const capped = orderAndCap(owned.kept, settings.writeCapPerCycle);
    const findings: Finding[] = [
        ...found.findings,
        ...removals.findings,
        ...owned.dropped,
    ];
    const body: PlanBody = {
        ops: capped.now,
        deferred: capped.deferred,
        findings,
        needsApproval: budget.needsApproval,
        approvalReason: budget.needsApproval ? budget.reason : null,
    };
    return { body, rows };
}

function planStatus(body: PlanBody, abortReason: string | null) {
    if (body.needsApproval) return 'pending-approval' as const;
    return abortReason ? ('aborted' as const) : ('dry-run' as const);
}

function newPlan(
    deps: CycleDeps,
    link: LinkedGuild,
    direction: SyncDirection,
    body: PlanBody,
    abortReason: string | null
): Plan {
    return {
        id: deps.newId(),
        guildLinkId: link.id,
        direction,
        status: planStatus(body, abortReason),
        body,
        abortReason,
    };
}

/** Saves, logs and posts a plan for a cycle the gates stopped. */
async function abortedPlan(
    link: LinkedGuild,
    settings: SyncSettings,
    gated: Extract<GateOutcome, { ok: false }>,
    deps: CycleDeps,
    now: Date
): Promise<Plan> {
    const body: PlanBody = gated.needsApproval
        ? { ...EMPTY_BODY, needsApproval: true, approvalReason: gated.reason }
        : EMPTY_BODY;
    const plan = newPlan(deps, link, settings.direction, body, gated.reason);
    deps.logger.warn(
        `[guild-sync] Cycle aborted for link ${link.id}: ${gated.reason}`
    );
    await publish(plan, settings, deps, now);
    return plan;
}

/** Used for a side whose images cannot be read: every lookup fails. */
const NO_ASSETS: AssetSource = {
    image: () => Promise.reject(new Error('no image source for this side')),
};

/**
 * Applies a saved plan (design: Cycle step 7). The process mode is read
 * again before every write, so a trip to read-only stops the run.
 */
async function applySaved(
    plan: Plan,
    gated: Extract<GateOutcome, { ok: true }>,
    rows: readonly MapRow[],
    deps: CycleDeps
): Promise<ApplyResult | null> {
    const toFluxer = plan.direction === 'discord-to-fluxer';
    const dest = toFluxer ? 'fluxer' : 'discord';
    const writer = deps.writers[dest];
    const sourceSide = toFluxer ? 'discord' : 'fluxer';
    const assets = deps.assets[sourceSide] ?? NO_ASSETS;
    if (!writer) {
        deps.logger.warn(
            `[guild-sync] Apply is on, but writing to ${dest} is not built. Plan ${plan.id} stays a dry-run.`
        );
        return null;
    }
    const result = await applyPlan(
        { plan, source: gated.source, destination: gated.destination, rows },
        {
            store: deps.store,
            writer,
            assets,
            links: deps.links,
            threads: deps.threadSources[sourceSide] ?? null,
            canWrite: () => deps.processMode() !== 'read-only',
            pause: deps.pause,
            now: deps.now,
            logger: deps.logger,
        }
    );
    const failed = result.failed > 0 || result.stopped !== null;
    await deps.store.setPlanStatus(
        plan.id,
        failed ? 'aborted' : 'applied',
        failed
            ? `apply: ${result.failed} failed${result.stopped ? `, ${result.stopped}` : ''}`
            : null,
        deps.now()
    );
    deps.logger.info(`[guild-sync] ${applyNotice(plan, result)}`);
    return result;
}

/** The approved plan, if an admin approved one that still waits. */
async function loadApproval(
    settings: SyncSettings,
    deps: CycleDeps
): Promise<Plan | null> {
    if (!settings.approvedPlanId) return null;
    const plan = await deps.store.getPlan(settings.approvedPlanId);
    return plan?.status === 'pending-approval' ? plan : null;
}

/** True when the admin approved exactly what this plan would do. */
function isApproved(plan: Plan, approved: Plan | null): boolean {
    if (!plan.body.needsApproval) return true;
    return (
        approved !== null &&
        stableJson(approved.body) === stableJson(plan.body) &&
        approved.abortReason === plan.abortReason
    );
}

/** Saves, logs and posts a plan. */
async function publish(
    plan: Plan,
    settings: SyncSettings,
    deps: CycleDeps,
    now: Date
): Promise<void> {
    await deps.store.savePlan(plan, now);
    deps.logger.info(`[guild-sync] ${summarizePlan(plan)}`);
    const notice = planNotice(plan, deps.commandPrefix);
    if (notice === null) return;
    await deps.notices.post(
        plan.guildLinkId,
        settings.adminChannelId,
        planFingerprint(plan),
        notice
    );
}

type Planned = Extract<CycleOutcome, { status: 'planned' }>;

/** Plans from healthy snapshots and applies the plan when it may. */
async function planAndApply(
    link: LinkedGuild,
    settings: SyncSettings,
    gated: Extract<GateOutcome, { ok: true }>,
    approved: Plan | null,
    deps: CycleDeps,
    now: Date
): Promise<Planned> {
    await saveIfChanged(deps.store, link.id, gated.source, now);
    await saveIfChanged(deps.store, link.id, gated.destination, now);
    const { body, rows } = await buildBody(link, settings, gated, deps, now);
    const plan = newPlan(deps, link, settings.direction, body, null);
    await publish(plan, settings, deps, now);
    const mode = resolveMode(deps.processMode(), settings, deps.allowApply);
    const runnable =
        mode.mode === 'apply' &&
        body.ops.length > 0 &&
        isApproved(plan, approved);
    const applied = runnable ? await applySaved(plan, gated, rows, deps) : null;
    if (!applied) return { status: 'planned', plan, more: false };
    await deps.notices.post(
        link.id,
        settings.adminChannelId,
        `applied:${plan.id}`,
        applyNotice(plan, applied)
    );
    // Only clean progress asks for another cycle, so a failing write is
    // retried at the normal pace and never in a tight loop.
    const more =
        applied.applied > 0 &&
        applied.failed === 0 &&
        applied.stopped === null &&
        body.deferred.length > 0;
    return { status: 'planned', plan, applied, more };
}

/**
 * One reconcile cycle for one guild link (design: Cycle steps 2 to 7).
 * It always saves a plan. The plan is applied only in apply mode, and a
 * plan that needs approval only after an admin approved that exact plan.
 */
export async function runCycle(
    link: LinkedGuild,
    deps: CycleDeps
): Promise<CycleOutcome> {
    const settings = await deps.store.loadSettings(link.id);
    const mode = resolveMode(deps.processMode(), settings, deps.allowApply);
    if (mode.mode === 'read-only')
        return { status: 'skipped', reason: mode.reason ?? 'read-only' };

    const now = deps.now();
    const approved = await loadApproval(settings, deps);
    // An approval is used by this cycle or dropped: it never carries over.
    if (settings.approvedPlanId) {
        await deps.store.setApprovedPlan(link.id, null, now);
    }
    const gated = await readAndGate(link, settings, deps, now, approved);
    if (!gated.ok) {
        const plan = await abortedPlan(link, settings, gated, deps, now);
        return { status: 'planned', plan, more: false };
    }
    return planAndApply(link, settings, gated, approved, deps, now);
}

import type { AddonMode } from '../addons/config';
import type { AddonLogger } from '../addons/isolation';
import type { JobTotals } from '../history/types';
import { resolveMode, type CycleOutcome } from './cycle';
import type { Plan } from './plan';
import {
    renderStatus,
    statusBody,
    type ApplyInfo,
    type PlanInfo,
    type StatusEmbed,
    type StatusView,
} from './status';
import type { GuildSyncStore, StatusMessageRef, SyncSettings } from './store';

/**
 * Keeps one live status message per guild link in its admin channel and
 * edits it in place. Updates are throttled per link: at most one edit per
 * interval, the latest state wins, and a change during the wait is never
 * lost, because it schedules one trailing edit. The message's place is
 * saved, so a restart edits the same message.
 */

/** Posts and edits the status message (notifier.ts on Discord). */
export interface StatusMessenger {
    /** Posts a new status message. Resolves to its message ID. */
    post(channelId: string, embed: StatusEmbed): Promise<string>;
    /** Edits it. 'missing' when the message no longer exists. */
    edit(
        channelId: string,
        messageId: string,
        embed: StatusEmbed
    ): Promise<'edited' | 'missing'>;
}

export interface StatusTimers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const NODE_TIMERS: StatusTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface StatusBoardDeps {
    readonly store: Pick<
        GuildSyncStore,
        | 'loadSettings'
        | 'lastPlan'
        | 'loadStatusMessage'
        | 'saveStatusMessage'
        | 'countMapped'
    >;
    readonly messenger: StatusMessenger;
    /** History job totals, when history import is on. */
    readonly historyTotals?: (guildLinkId: string) => Promise<JobTotals>;
    readonly processMode: () => AddonMode;
    readonly allowApply: boolean;
    readonly commandPrefix: string;
    readonly now: () => Date;
    readonly logger: AddonLogger;
    readonly timers?: StatusTimers;
    /** Shortest time between two edits of one link's message. */
    readonly intervalMs?: number;
}

/** At most one edit per link in this window. */
export const STATUS_INTERVAL_MS = 30_000;
/** An unchanged status is still re-edited this often, to move "Updated". */
export const STATUS_REFRESH_MS = 10 * 60_000;
/** A failing update is logged at most once per link in this window. */
export const STATUS_WARN_INTERVAL_MS = 10 * 60_000;
/** Upper bound on links tracked; past it, new links get no status. */
export const MAX_STATUS_LINKS = 200;

/** One link's throttle state and what this process saw it do. */
interface LinkSlot {
    planAt: { readonly planId: string; readonly at: Date } | null;
    apply: ApplyInfo | null;
    timer: unknown;
    running: Promise<void> | null;
    dirty: boolean;
    lastStartedAt: number | null;
    /** What the message showed after the last write, and where. */
    written: {
        readonly ref: StatusMessageRef;
        readonly body: string;
        readonly at: number;
    } | null;
    lastWarnAt: number | null;
}

function newSlot(): LinkSlot {
    return {
        planAt: null,
        apply: null,
        timer: null,
        running: null,
        dirty: false,
        lastStartedAt: null,
        written: null,
        lastWarnAt: null,
    };
}

/** The plan as the status shows it, with its time if this process saved it. */
function planInfo(plan: Plan | null, slot: LinkSlot): PlanInfo | null {
    if (!plan) return null;
    const at = slot.planAt?.planId === plan.id ? slot.planAt.at : null;
    return {
        id: plan.id,
        status: plan.status,
        abortReason: plan.abortReason,
        deferred: plan.body.deferred.length,
        at,
    };
}

const sameRef = (a: StatusMessageRef, b: StatusMessageRef) =>
    a.channelId === b.channelId && a.messageId === b.messageId;

export class StatusBoard {
    private readonly slots = new Map<string, LinkSlot>();
    private readonly timers: StatusTimers;
    private readonly intervalMs: number;
    private stopped = false;

    constructor(private readonly deps: StatusBoardDeps) {
        this.timers = deps.timers ?? NODE_TIMERS;
        this.intervalMs = deps.intervalMs ?? STATUS_INTERVAL_MS;
        if (!(this.intervalMs > 0)) {
            throw new RangeError('Invalid status interval');
        }
    }

    /** Records what a cycle did and schedules an update. */
    recordCycle(guildLinkId: string, outcome: CycleOutcome | null): void {
        const slot = this.slot(guildLinkId);
        if (!slot) return;
        if (outcome?.status === 'planned') {
            const at = this.deps.now();
            slot.planAt = { planId: outcome.plan.id, at };
            const { applied } = outcome;
            if (applied) {
                slot.apply = {
                    planId: outcome.plan.id,
                    at,
                    applied: applied.applied,
                    failed: applied.failed,
                    notApplied: applied.skipped.length,
                    stopped: applied.stopped,
                };
            }
        }
        this.request(guildLinkId);
    }

    /** Schedules an update of the link's message, throttled. */
    request(guildLinkId: string): void {
        if (this.stopped) return;
        const slot = this.slot(guildLinkId);
        if (!slot) return;
        slot.dirty = true;
        this.schedule(guildLinkId, slot);
    }

    /** Cancels pending updates and waits for those in flight. */
    async stop(): Promise<void> {
        this.stopped = true;
        const running: Promise<void>[] = [];
        for (const slot of this.slots.values()) {
            if (slot.timer !== null) this.timers.clearTimeout(slot.timer);
            slot.timer = null;
            slot.dirty = false;
            if (slot.running) running.push(slot.running);
        }
        await Promise.all(running);
    }

    private slot(guildLinkId: string): LinkSlot | null {
        const known = this.slots.get(guildLinkId);
        if (known) return known;
        if (this.slots.size >= MAX_STATUS_LINKS) return null;
        const slot = newSlot();
        this.slots.set(guildLinkId, slot);
        return slot;
    }

    private schedule(guildLinkId: string, slot: LinkSlot): void {
        if (slot.timer !== null || slot.running !== null) return;
        const now = this.deps.now().getTime();
        const since = slot.lastStartedAt;
        const wait =
            since === null ? 0 : Math.max(since + this.intervalMs - now, 0);
        slot.timer = this.timers.setTimeout(
            () => this.fire(guildLinkId, slot),
            wait
        );
    }

    private fire(guildLinkId: string, slot: LinkSlot): void {
        slot.timer = null;
        if (this.stopped || !slot.dirty) return;
        slot.dirty = false;
        slot.lastStartedAt = this.deps.now().getTime();
        slot.running = this.refresh(guildLinkId, slot).finally(() => {
            slot.running = null;
            if (slot.dirty && !this.stopped) this.schedule(guildLinkId, slot);
        });
    }

    /** Updates the message. Never rejects: failures are logged, throttled. */
    private async refresh(guildLinkId: string, slot: LinkSlot): Promise<void> {
        try {
            await this.publish(guildLinkId, slot);
        } catch (error) {
            this.warn(guildLinkId, slot, error);
        }
    }

    private warn(guildLinkId: string, slot: LinkSlot, error: unknown): void {
        const now = this.deps.now().getTime();
        const last = slot.lastWarnAt;
        if (last !== null && now - last < STATUS_WARN_INTERVAL_MS) return;
        slot.lastWarnAt = now;
        const detail = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn(
            `[guild-sync] Could not update the status message for link ${guildLinkId}: ${detail}`
        );
    }

    private async view(
        guildLinkId: string,
        settings: SyncSettings,
        slot: LinkSlot
    ): Promise<StatusView> {
        const { store, historyTotals } = this.deps;
        const plan = await store.lastPlan(guildLinkId);
        return {
            settings,
            mode: resolveMode(
                this.deps.processMode(),
                settings,
                this.deps.allowApply
            ),
            allowApply: this.deps.allowApply,
            commandPrefix: this.deps.commandPrefix,
            plan: planInfo(plan, slot),
            apply: slot.apply,
            mapped: await store.countMapped(guildLinkId),
            history: historyTotals ? await historyTotals(guildLinkId) : null,
            updatedAt: this.deps.now(),
        };
    }

    /** True when the message already shows this and was written recently. */
    private unchanged(
        slot: LinkSlot,
        ref: StatusMessageRef,
        body: string
    ): boolean {
        const { written } = slot;
        if (!written || !sameRef(written.ref, ref) || written.body !== body) {
            return false;
        }
        return this.deps.now().getTime() - written.at < STATUS_REFRESH_MS;
    }

    /**
     * Edits the saved message, or posts a new one when there is none, it
     * is gone, or the admin channel changed. Any other edit failure throws,
     * so no duplicate is posted.
     */
    private async publish(guildLinkId: string, slot: LinkSlot): Promise<void> {
        const { store, messenger } = this.deps;
        const settings = await store.loadSettings(guildLinkId);
        const channelId = settings.adminChannelId;
        if (!channelId) return;
        const view = await this.view(guildLinkId, settings, slot);
        const body = statusBody(view);
        const embed = renderStatus(view);
        const saved = await store.loadStatusMessage(guildLinkId);
        if (saved && saved.channelId === channelId) {
            if (this.unchanged(slot, saved, body)) return;
            const result = await messenger.edit(
                channelId,
                saved.messageId,
                embed
            );
            if (result === 'edited') {
                this.remember(slot, saved, body);
                return;
            }
        }
        const messageId = await messenger.post(channelId, embed);
        const ref = { channelId, messageId };
        await store.saveStatusMessage(guildLinkId, ref);
        this.remember(slot, ref, body);
    }

    private remember(slot: LinkSlot, ref: StatusMessageRef, body: string) {
        slot.written = { ref, body, at: this.deps.now().getTime() };
    }
}

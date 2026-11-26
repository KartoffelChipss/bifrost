import type { AssetSource } from '../../src/guild-sync/assets';
import type { MissingUpdate } from '../../src/guild-sync/guards';
import type {
    ChannelLinker,
    LinkedChannel,
    ThreadSource,
} from '../../src/guild-sync/links';
import type { ReadResult } from '../../src/guild-sync/health';
import { NoticeBoard } from '../../src/guild-sync/notices';
import type { MapRow } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import type { GuildReader } from '../../src/guild-sync/readers/reader';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import {
    LEADER_LOCK_KEY,
    THREAD_RESET_OP,
    type AuditEntry,
    type CopiedThread,
    type GuildSyncStore,
    type MappedCounts,
    type NewMapping,
    type StatusMessageRef,
    type SyncSettings,
    type ThreadMessage,
    type ThreadResetAudit,
    type ThreadResetCleared,
} from '../../src/guild-sync/store';
import type { HistoryJob } from '../../src/history/types';

/** A parked reply, as `addon_parked_messages` keys it. */
export interface FakeParked {
    readonly side: 'discord' | 'fluxer';
    readonly threadId: string;
    readonly messageId: string;
}

/** An imported history message, by its job. */
export interface FakeHistoryMessage {
    readonly discordMessageId: string;
    readonly jobId: string;
}

/** A history job fresh from ensureJob (history/store.ts). */
export function freshJob(
    id: string,
    discordId: string,
    overrides: Partial<HistoryJob> = {}
): HistoryJob {
    return {
        id,
        guildLinkId: 'link-1',
        kind: 'thread',
        discordId,
        parentDiscordId: null,
        fluxerId: null,
        status: 'pending',
        cutoffId: null,
        checkpointId: '0',
        catchUps: 0,
        imported: 0,
        failures: 0,
        retries: 0,
        failingId: null,
        retryAt: null,
        skipped: 0,
        skipStreak: 0,
        streakFromId: null,
        messageCount: null,
        attachmentCount: null,
        surveyedAt: null,
        importWebhook: null,
        archiveThreadId: null,
        lastError: null,
        ...overrides,
    };
}

export const DEFAULT_SETTINGS: SyncSettings = {
    mode: 'dry-run',
    direction: 'discord-to-fluxer',
    killSwitch: false,
    enforceDrift: false,
    adminChannelId: null,
    approvedPlanId: null,
    shrinkPercent: 10,
    shrinkMinObjects: 5,
    confirmChecks: 3,
    confirmMinutes: 30,
    gracePeriodDays: 14,
    deleteBudgetPerCycle: 3,
    deleteBudgetPerDay: 10,
    writeCapPerCycle: 50,
};

/** An in-memory store that records every write. */
export class FakeStore implements GuildSyncStore {
    settings: SyncSettings = DEFAULT_SETTINGS;
    rows: MapRow[] = [];
    snapshots: { snapshot: GuildSnapshot; healthy: boolean }[] = [];
    missingWrites: MissingUpdate[][] = [];
    plans: Plan[] = [];
    audits: AuditEntry[] = [];
    /** When each audit row was written, by index into `audits`. */
    auditTimes: Date[] = [];
    statusMessage: StatusMessageRef | null = null;
    /** The guild-sync leader lock (LEADER_LOCK_KEY). */
    lockHeld = false;
    /** Other locks held, by key, such as the history lock. */
    readonly heldKeys = new Set<number>();
    /** Set by a test to make the held check fail. */
    lockLost = false;
    /** Rows a thread reset clears, beside the map. */
    threadMessages: ThreadMessage[] = [];
    parked: FakeParked[] = [];
    historyJobs: HistoryJob[] = [];
    historyMessages: FakeHistoryMessage[] = [];
    /** Every thread forgetCopiedThread was asked to forget, in order. */
    readonly forgotten: CopiedThread[] = [];
    /** Set by a test to make forgetCopiedThread fail. */
    failForget = false;
    private mapSeq = 0;

    async withLeaderLock<T>(
        _holder: string,
        fn: (held: () => Promise<boolean>) => Promise<T>,
        key = LEADER_LOCK_KEY
    ) {
        const leader = key === LEADER_LOCK_KEY;
        if (leader ? this.lockHeld : this.heldKeys.has(key)) {
            return { ran: false as const };
        }
        if (leader) this.lockHeld = true;
        else this.heldKeys.add(key);
        try {
            return {
                ran: true as const,
                value: await fn(async () => !this.lockLost),
            };
        } finally {
            if (leader) this.lockHeld = false;
            else this.heldKeys.delete(key);
        }
    }

    async loadSettings() {
        return this.settings;
    }

    async loadObjectMap() {
        return this.rows;
    }

    async lastSnapshot(_link: string, side: string, healthyOnly: boolean) {
        const match = [...this.snapshots]
            .reverse()
            .find(
                (s) => s.snapshot.side === side && (s.healthy || !healthyOnly)
            );
        return match?.snapshot ?? null;
    }

    async saveSnapshot(
        _link: string,
        snapshot: GuildSnapshot,
        healthy: boolean
    ) {
        this.snapshots.push({ snapshot, healthy });
    }

    async saveMissing(updates: readonly MissingUpdate[]) {
        if (updates.length === 0) return;
        this.missingWrites.push([...updates]);
        const byRow = new Map(updates.map((u) => [u.rowId, u]));
        this.rows = this.rows.map((row) => {
            const update = byRow.get(row.id);
            return update
                ? {
                      ...row,
                      missingCount: update.missingCount,
                      missingSince: update.missingSince,
                  }
                : row;
        });
    }

    async savePlan(plan: Plan) {
        this.plans.push(plan);
    }

    async removalsSince() {
        return this.audits.filter(
            (a) =>
                a.result === 'ok' &&
                (a.op === 'archive' || a.op === 'hard-delete')
        ).length;
    }

    async pruneSnapshots() {}

    async prunePlans() {
        return 0;
    }

    async pruneTombstoned() {
        const before = this.rows.length;
        this.rows = this.rows.filter((row) => row.state !== 'tombstoned');
        return before - this.rows.length;
    }

    async insertMapping(mapping: NewMapping): Promise<MapRow> {
        const row: MapRow = {
            id: `map-${++this.mapSeq}`,
            kind: mapping.kind,
            discordId: mapping.discordId,
            fluxerId: mapping.fluxerId,
            state: 'active',
            createdBySync: mapping.createdBySync,
            missingSince: null,
            missingCount: 0,
            appliedFields: mapping.appliedFields,
        };
        this.rows = [...this.rows, row];
        return row;
    }

    async saveApplied(rowId: string, fields: MapRow['appliedFields']) {
        this.rows = this.rows.map((row) =>
            row.id === rowId ? { ...row, appliedFields: fields } : row
        );
    }

    async audit(entry: AuditEntry, now: Date) {
        this.audits.push(entry);
        this.auditTimes.push(now);
    }

    async createIntents(_link: string, since: Date) {
        return this.audits.flatMap((entry, i) => {
            const at = this.auditTimes[i];
            const after = entry.after as {
                name?: unknown;
                refused?: unknown;
            } | null;
            const name = after?.name;
            const intent =
                entry.op === 'create-intent' &&
                at >= since &&
                entry.sourceId !== null &&
                entry.kind !== 'overwrite' &&
                typeof name === 'string';
            return intent
                ? [
                      {
                          kind: entry.kind,
                          sourceId: entry.sourceId,
                          name,
                          at,
                          refused: after?.refused === true,
                      },
                  ]
                : [];
        });
    }

    async setPlanStatus(
        planId: string,
        status: Plan['status'],
        abortReason: string | null
    ) {
        this.plans = this.plans.map((plan) =>
            plan.id === planId ? { ...plan, status, abortReason } : plan
        );
    }

    async setMode(_link: string, mode: SyncSettings['mode']) {
        this.settings = { ...this.settings, mode };
    }

    async setKillSwitch(_link: string, on: boolean) {
        this.settings = { ...this.settings, killSwitch: on };
    }

    async setEnforceDrift(_link: string, on: boolean) {
        this.settings = { ...this.settings, enforceDrift: on };
    }

    async setAdminChannel(_link: string, adminChannelId: string | null) {
        this.settings = { ...this.settings, adminChannelId };
    }

    async setApprovedPlan(_link: string, approvedPlanId: string | null) {
        this.settings = { ...this.settings, approvedPlanId };
    }

    async setRowState(rowId: string, state: MapRow['state']) {
        this.rows = this.rows.map((row) =>
            row.id === rowId ? { ...row, state } : row
        );
    }

    async getPlan(planId: string) {
        return this.plans.find((plan) => plan.id === planId) ?? null;
    }

    async lastPlan() {
        return this.plans[this.plans.length - 1] ?? null;
    }

    async loadStatusMessage() {
        return this.statusMessage;
    }

    async saveStatusMessage(_link: string, ref: StatusMessageRef | null) {
        this.statusMessage = ref;
    }

    async forgetCopiedThread(
        guildLinkId: string,
        thread: CopiedThread,
        audit: ThreadResetAudit,
        now: Date
    ): Promise<ThreadResetCleared> {
        if (this.failForget) throw new Error('database unavailable');
        this.forgotten.push(thread);
        const cleared: ThreadResetCleared = {
            mapRows: this.dropMapRow(thread),
            threadMessages: this.dropThreadMessages(thread),
            parkedMessages: this.dropParked(thread),
            historyMessages: this.dropHistoryMessages(thread.discordId),
            historyJobs: this.resetJobs(thread.discordId),
            intents: this.refuseIntents(guildLinkId, thread, audit, now),
        };
        await this.audit(
            {
                planId: audit.runId,
                guildLinkId,
                op: THREAD_RESET_OP,
                kind: 'thread',
                sourceId: thread.discordId,
                destId: thread.fluxerId,
                before: null,
                after: { gone: audit.gone, cleared: { ...cleared } },
                result: 'ok',
            },
            now
        );
        return cleared;
    }

    private dropMapRow(t: CopiedThread): number {
        const before = this.rows.length;
        this.rows = this.rows.filter(
            (r) =>
                !(
                    r.id === t.rowId &&
                    r.kind === 'thread' &&
                    r.state === 'active' &&
                    r.createdBySync &&
                    r.discordId === t.discordId &&
                    r.fluxerId === t.fluxerId
                )
        );
        return before - this.rows.length;
    }

    private dropThreadMessages(t: CopiedThread): number {
        const before = this.threadMessages.length;
        this.threadMessages = this.threadMessages.filter(
            (m) =>
                m.discordThreadId !== t.discordId &&
                m.fluxerThreadId !== t.fluxerId
        );
        return before - this.threadMessages.length;
    }

    private dropParked(t: CopiedThread): number {
        const before = this.parked.length;
        this.parked = this.parked.filter((p) =>
            p.side === 'discord'
                ? p.threadId !== t.discordId
                : p.threadId !== t.fluxerId
        );
        return before - this.parked.length;
    }

    private threadJobIds(discordId: string): Set<string> {
        return new Set(
            this.historyJobs
                .filter((j) => j.kind === 'thread' && j.discordId === discordId)
                .map((j) => j.id)
        );
    }

    private dropHistoryMessages(discordId: string): number {
        const jobs = this.threadJobIds(discordId);
        const before = this.historyMessages.length;
        this.historyMessages = this.historyMessages.filter(
            (m) => !jobs.has(m.jobId)
        );
        return before - this.historyMessages.length;
    }

    private resetJobs(discordId: string): number {
        const jobs = this.threadJobIds(discordId);
        this.historyJobs = this.historyJobs.map((j) =>
            jobs.has(j.id)
                ? freshJob(j.id, j.discordId, {
                      guildLinkId: j.guildLinkId,
                      parentDiscordId: j.parentDiscordId,
                  })
                : j
        );
        return jobs.size;
    }

    private refuseIntents(
        guildLinkId: string,
        t: CopiedThread,
        audit: ThreadResetAudit,
        now: Date
    ): number {
        const names = new Set<string>();
        for (const entry of this.audits) {
            const name = (entry.after as { name?: unknown } | null)?.name;
            if (
                entry.op === 'create-intent' &&
                entry.result === 'intent' &&
                entry.kind === 'thread' &&
                entry.sourceId === t.discordId &&
                typeof name === 'string'
            ) {
                names.add(name);
            }
        }
        for (const name of names) {
            this.audits.push({
                planId: audit.runId,
                guildLinkId,
                op: 'create-intent',
                kind: 'thread',
                sourceId: t.discordId,
                destId: null,
                before: null,
                after: { name, refused: true },
                result: 'refused',
            });
            this.auditTimes.push(now);
        }
        return names.size;
    }

    async countMapped(): Promise<MappedCounts> {
        const counts: Partial<Record<MapRow['kind'], number>> = {};
        for (const row of this.rows) {
            if (row.state !== 'active') continue;
            counts[row.kind] = (counts[row.kind] ?? 0) + 1;
        }
        return counts;
    }
}

/** A reader that returns fixed results and answers lookups from a set. */
export class FakeReader implements GuildReader {
    lookups = 0;

    constructor(
        public result: ReadResult,
        public gone: ReadonlySet<string> = new Set()
    ) {}

    async read() {
        return this.result;
    }

    async isGone(_guildId: string, _kind: string, id: string) {
        this.lookups += 1;
        return this.gone.has(id);
    }
}

/** Serves a tiny PNG or GIF for any emoji or sticker. */
export class FakeAssets implements AssetSource {
    readonly requests: string[] = [];
    /** IDs served as GIF, as an animated emoji would be. */
    readonly animated = new Set<string>();

    async image(_guild: string, kind: 'emoji' | 'sticker', id: string) {
        this.requests.push(`${kind}:${id}`);
        const type = this.animated.has(id) ? 'gif' : 'png';
        return `data:image/${type};base64,AAAA`;
    }
}

/** A notice board that records what it would post. */
export function recordingNotices() {
    const posted: { channelId: string; text: string }[] = [];
    const quiet = { info() {}, warn() {}, error() {} };
    const board = new NoticeBoard(async (channelId, text) => {
        posted.push({ channelId, text });
    }, quiet);
    return { board, posted };
}

/** Channel links held in memory, as upstream's link service would. */
export class FakeLinker implements ChannelLinker {
    links: LinkedChannel[] = [];
    readonly unlinked: string[] = [];

    async linkedDiscordChannels() {
        return new Set(this.links.map((l) => l.discordChannelId));
    }

    async link(guildLinkId: string, discordId: string, fluxerId: string) {
        this.links.push({
            id: `link-${discordId}`,
            guildLinkId,
            discordChannelId: discordId,
            fluxerChannelId: fluxerId,
            discordWebhook: { id: `dw-${discordId}`, token: 'secret' },
            fluxerWebhook: { id: `fw-${fluxerId}`, token: 'secret' },
        });
    }

    async unlink(discordChannelId: string) {
        this.unlinked.push(discordChannelId);
        this.links = this.links.filter(
            (l) => l.discordChannelId !== discordChannelId
        );
    }

    async byDiscordChannel(id: string) {
        return this.links.find((l) => l.discordChannelId === id) ?? null;
    }

    async byFluxerChannel(id: string) {
        return this.links.find((l) => l.fluxerChannelId === id) ?? null;
    }
}

/** Gives every thread a first message that names the thread. */
export class FakeThreadSource implements ThreadSource {
    async starter(_guild: string, threadId: string) {
        return {
            content: `first message of ${threadId}`,
            username: 'author',
            avatarURL: 'https://cdn.example/avatar.png',
        };
    }
}

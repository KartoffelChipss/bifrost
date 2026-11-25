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
import type {
    AuditEntry,
    GuildSyncStore,
    NewMapping,
    SyncSettings,
} from '../../src/guild-sync/store';

export const DEFAULT_SETTINGS: SyncSettings = {
    mode: 'dry-run',
    direction: 'discord-to-fluxer',
    killSwitch: false,
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
    lockHeld = false;
    private mapSeq = 0;

    async withLeaderLock<T>(_holder: string, fn: () => Promise<T>) {
        if (this.lockHeld) return { ran: false as const };
        this.lockHeld = true;
        try {
            return { ran: true as const, value: await fn() };
        } finally {
            this.lockHeld = false;
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

    async audit(entry: AuditEntry) {
        this.audits.push(entry);
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

import type { AddonLogger } from '../addons/isolation';
import type { LinkedGuild } from '../guild-sync/cycle';
import type { ChannelLinker, RelayPayload } from '../guild-sync/links';
import type { MapRow } from '../guild-sync/ops';
import {
    LINKED_CHANNEL_TYPES,
    excludedIds,
    type GuildSnapshot,
} from '../guild-sync/snapshot';
import type { GuildWriter } from '../guild-sync/writers/writer';
import {
    MessageError,
    describeError,
    isTargetError,
    isTransient,
    isUnknownWebhook,
    isUploadError,
} from './errors';
import { ArchiveThreads } from './archive';
import { CopyFormatter, contentHash, withNote } from './format';
import {
    MAX_PARALLEL,
    PAGE_SIZE,
    PASS_BUDGET_MS,
    SEND_INTERVAL_MS,
} from './limits';
import { MAX_JOBS, type HistoryStore } from './store';
import { HistorySurvey } from './survey';
import type {
    HistoryJob,
    HistoryPorts,
    ImportedMessage,
    JobKey,
    JobKind,
    JobPatch,
    JobStatus,
    SendTarget,
    SourceMessage,
} from './types';

/**
 * Copies past Discord messages to Fluxer, oldest first (design: Message
 * history import). A text channel is copied before it is bridged, so its
 * history sits above live messages and nothing echoes. A thread or forum
 * post is copied through its bridged parent's webhook while the thread
 * relay holds new replies back.
 */

export { MAX_PARALLEL, PAGE_SIZE, PASS_BUDGET_MS, SEND_INTERVAL_MS };
/** Extra passes for messages posted while a channel was being copied. */
export const MAX_CATCH_UPS = 2;
/**
 * Runs in a row with a lasting error (such as a 4xx) before the message
 * at fault is skipped, or the job fails when no message is at fault.
 * Temporary errors never count.
 */
export const MAX_FAILURES = 5;
/**
 * Messages skipped in a row before the job fails: so many failing at
 * once points at the target, not at the messages.
 */
export const MAX_SKIP_STREAK = 10;
/** First wait after an error; it doubles per error in a row, up to the max. */
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** Doublings before the wait reaches its cap; bounds the exponent. */
const MAX_DOUBLINGS = 20;

/** The wait before the next run after `count` errors in a row. */
export function backoffMs(count: number): number {
    const doublings = Math.min(Math.max(count - 1, 0), MAX_DOUBLINGS);
    return Math.min(RETRY_BASE_MS * Math.pow(2, doublings), RETRY_MAX_MS);
}
/** Pages read per pass after a channel is bridged, to close the gap. */
export const MAX_GAP_PAGES = 5;
/**
 * Recent Fluxer messages searched for a copy cut off by a crash: one
 * page, Fluxer's maximum (packages/schema MessageRequestSchemas, limit
 * maxValue 100), so a wider search costs no extra request.
 */
export const RECOVERY_SCAN = 100;
/** Pinned messages read per channel or thread. */
const MAX_PINS = 250;

/** Channel types with their own messages: text, voice and announcement. */
const MESSAGE_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 2, 5]);

export type HistoryMode = 'read-only' | 'dry-run' | 'apply';

export interface ImporterDeps {
    readonly store: HistoryStore;
    /** guild-sync's view: what exists on Discord and what is mapped. */
    readonly sync: {
        lastSnapshot(linkId: string): Promise<GuildSnapshot | null>;
        loadObjectMap(linkId: string): Promise<MapRow[]>;
    };
    readonly ports: HistoryPorts;
    readonly links: ChannelLinker;
    readonly writer: Pick<GuildWriter, 'updateThread' | 'createThread'>;
    /**
     * Archive-thread mode: channels with more messages than this get their
     * history in a thread and are bridged at once. 0 or absent: inline.
     */
    readonly inlineMax?: number;
    /**
     * Records a thread state written straight to Fluxer in guild-sync's
     * object map, so its next cycle does not take it for drift.
     */
    readonly recordThreadState: (
        linkId: string,
        discordThreadId: string,
        state: { archived: boolean; locked: boolean }
    ) => Promise<void>;
    /** Discord channel or category IDs never imported. */
    readonly excluded: ReadonlySet<string>;
    /**
     * The link's admin channel, read again every pass. Like an excluded
     * channel it is never imported: guild-sync never bridges it, so its
     * notices stay on Discord.
     */
    readonly adminChannel: (linkId: string) => Promise<string | null>;
    /** Upstream's command prefix, which copies must not start with. */
    readonly commandPrefix: string;
    /** The link's mode now. Read again before every message. */
    readonly mode: (linkId: string) => Promise<HistoryMode>;
    readonly report: (
        linkId: string,
        key: string,
        text: string
    ) => Promise<void>;
    readonly pause: (ms: number) => Promise<void>;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

/** One pass over one guild link. */
interface Pass {
    readonly link: LinkedGuild;
    /** Time in ms after which no new message is started. */
    readonly deadline: number;
    /** Message channels guild-sync cannot bridge (see `plan`). */
    readonly unbridged: ReadonlySet<string>;
    /** Discord channel types by ID, from the snapshot. */
    readonly channelTypes: ReadonlyMap<string, number>;
    /** False once the history leader lock is lost: writes stop. */
    readonly held: () => Promise<boolean>;
}

/** What a pass works on, besides the link and the deadline. */
type PassPlan = Omit<Pass, 'link' | 'deadline' | 'held'> & {
    readonly jobs: HistoryJob[];
};

/** Where a job's copies go, and the bridge whose Discord posts it skips. */
interface Route {
    readonly target: SendTarget;
    /**
     * Discord webhooks whose posts are copies of Fluxer messages: the
     * bridge's, and any earlier Bifröst bridge webhook in the channel.
     */
    readonly relayHooks: ReadonlySet<string>;
}

const later = (a: string, b: string) => BigInt(a) > BigInt(b);

/** Discord's snowflake epoch: 2015-01-01T00:00:00Z. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** When a Discord snowflake was made, in ms since the Unix epoch. */
export function snowflakeTime(id: string): number {
    return Number(BigInt(id) >> BigInt(22)) + DISCORD_EPOCH_MS;
}

/** The largest snowflake made before `at`: a cutoff that leaves it out. */
export function snowflakeBefore(at: Date): string {
    const ms = Math.floor(at.getTime());
    if (!Number.isFinite(ms) || ms <= DISCORD_EPOCH_MS) return '0';
    const first = BigInt(ms - DISCORD_EPOCH_MS) << BigInt(22);
    return (first - BigInt(1)).toString();
}

/** A source channel or thread with no job yet. */
interface NewJob {
    readonly kind: JobKind;
    readonly discordId: string;
    readonly parentId: string | null;
}

/** Message channels and threads in the snapshot that have no job. */
function missingJobs(
    snapshot: GuildSnapshot,
    skip: ReadonlySet<string>,
    known: ReadonlySet<string>
): NewJob[] {
    const out: NewJob[] = [];
    for (const channel of snapshot.channels) {
        if (!MESSAGE_CHANNEL_TYPES.has(channel.type)) continue;
        if (skip.has(channel.id) || known.has(`channel:${channel.id}`))
            continue;
        out.push({ kind: 'channel', discordId: channel.id, parentId: null });
    }
    for (const thread of snapshot.threads) {
        if (skip.has(thread.id) || known.has(`thread:${thread.id}`)) continue;
        out.push({
            kind: 'thread',
            discordId: thread.id,
            parentId: thread.parentId,
        });
    }
    return out;
}

/** Message channels guild-sync cannot bridge: no gap to close there. */
function unbridgedOf(snapshot: GuildSnapshot | null): Set<string> {
    return new Set(
        (snapshot?.channels ?? [])
            .filter(
                (c) =>
                    !LINKED_CHANNEL_TYPES.has(c.type) || c.bridgeable === false
            )
            .map((c) => c.id)
    );
}

/** A job for the admin channel or a thread in it. */
function inAdminChannel(job: HistoryJob, adminId: string | null): boolean {
    if (adminId === null) return false;
    return job.discordId === adminId || job.parentDiscordId === adminId;
}

const ADMIN_SKIPPED = 'skipped: the admin channel is never imported';

/** Stops a run cleanly when writes are switched off mid-way. */
class StoppedError extends Error {}

export class HistoryImporter {
    private readonly formatter: CopyFormatter;
    private readonly survey: HistorySurvey;
    private readonly archive: ArchiveThreads;

    constructor(private readonly deps: ImporterDeps) {
        this.formatter = new CopyFormatter(deps);
        this.survey = new HistorySurvey(deps);
        this.archive = new ArchiveThreads({
            ...deps,
            inlineMax: deps.inlineMax ?? 0,
        });
    }

    /**
     * Creates a job for every source channel and thread, and maps targets.
     * Returns the jobs that may run: excluded channels, the admin channel
     * and their threads are left out, even when a job was created before
     * they were excluded.
     */
    async planJobs(link: LinkedGuild): Promise<HistoryJob[]> {
        return (await this.plan(link, false)).jobs;
    }

    /** `open`: list only jobs neither done nor failed, as apply needs. */
    private async plan(link: LinkedGuild, open: boolean): Promise<PassPlan> {
        const { store, sync } = this.deps;
        const snapshot = await sync.lastSnapshot(link.id);
        const adminId = await this.deps.adminChannel(link.id);
        const listed = new Set(this.deps.excluded);
        if (adminId) listed.add(adminId);
        const skip = snapshot ? excludedIds(snapshot, listed) : listed;
        if (snapshot) await this.createJobs(link, snapshot, skip);
        const jobs = open
            ? await store.listOpenJobs(link.id)
            : await store.listJobs(link.id);
        await this.retireAdminJobs(jobs, adminId);
        return {
            jobs: jobs.filter(
                (job) =>
                    !skip.has(job.discordId) && !inAdminChannel(job, adminId)
            ),
            unbridged: unbridgedOf(snapshot),
            channelTypes: new Map(
                (snapshot?.channels ?? []).map((c) => [c.id, c.type])
            ),
        };
    }

    /**
     * Marks done the jobs of an admin channel set after they were made, so
     * they never import and never hold the end-of-import report back.
     */
    private async retireAdminJobs(
        jobs: readonly HistoryJob[],
        adminId: string | null
    ): Promise<void> {
        const { store, now } = this.deps;
        for (const job of jobs) {
            if (job.status === 'done' || !inAdminChannel(job, adminId))
                continue;
            await store.updateJob(
                job.id,
                { status: 'done', lastError: ADMIN_SKIPPED },
                now()
            );
        }
    }

    /**
     * Makes jobs for new source channels and threads, up to MAX_JOBS per
     * link. Past the bound no job is made, and the jobs already made go on.
     */
    private async createJobs(
        link: LinkedGuild,
        snapshot: GuildSnapshot,
        skip: ReadonlySet<string>
    ): Promise<void> {
        const { store, now } = this.deps;
        const keys = await store.jobKeys(link.id);
        const known = new Set(keys.map((k) => `${k.kind}:${k.discordId}`));
        const missing = missingJobs(snapshot, skip, known);
        const room = Math.max(MAX_JOBS - keys.length, 0);
        if (missing.length > room) {
            await this.warnFull(link, missing.length - room);
        }
        for (const job of missing.slice(0, room)) {
            await store.ensureJob(
                link.id,
                job.kind,
                job.discordId,
                job.parentId,
                now()
            );
        }
        await this.mapTargets(link);
    }

    /** Links already warned that they reached MAX_JOBS. */
    private readonly fullLinks = new Set<string>();

    /** Warns once per link and process that new sources get no job. */
    private async warnFull(link: LinkedGuild, left: number): Promise<void> {
        if (this.fullLinks.has(link.id)) return;
        this.fullLinks.add(link.id);
        const text = `History import reached ${MAX_JOBS} channels and threads: ${left} more get no history. The jobs already made go on.`;
        this.deps.logger.warn(`[history] Guild link ${link.id}: ${text}`);
        await this.deps.report(link.id, `full:${MAX_JOBS}`, text);
    }

    private async mapTargets(link: LinkedGuild): Promise<void> {
        const { store, sync, now } = this.deps;
        const rows = await sync.loadObjectMap(link.id);
        const target = new Map<string, string>();
        for (const row of rows) {
            if (row.state !== 'active' || !row.discordId || !row.fluxerId)
                continue;
            if (row.kind === 'channel' || row.kind === 'thread') {
                target.set(`${row.kind}:${row.discordId}`, row.fluxerId);
            }
        }
        const keys: JobKey[] = await store.jobKeys(link.id);
        for (const job of keys) {
            const fluxerId = target.get(`${job.kind}:${job.discordId}`);
            if (fluxerId && fluxerId !== job.fluxerId) {
                await store.updateJob(job.id, { fluxerId }, now());
            }
        }
    }

    /**
     * One pass for one guild link. In dry-run it counts messages; in apply
     * it copies them. Returns true when work is left for another pass.
     * No new message is started after `deadline` (ms), nor once `held`
     * says the history leader lock is lost.
     */
    async run(
        link: LinkedGuild,
        deadline = this.deps.now().getTime() + PASS_BUDGET_MS,
        held: () => Promise<boolean> = async () => true
    ): Promise<boolean> {
        const mode = await this.deps.mode(link.id);
        if (mode === 'read-only') return false;
        const plan = await this.plan(link, mode === 'apply');
        if (mode === 'dry-run')
            return this.survey.run(link, plan.jobs, deadline);
        const { jobs, ...rest } = plan;
        return this.importAll({ link, deadline, held, ...rest }, jobs);
    }

    /**
     * True while a job of this link waits for a time rather than for work:
     * a backoff after an error, or a copied channel waiting for its
     * bridge, whose gap pass should start soon after the link. The add-on
     * polls sooner than when idle.
     */
    async waiting(linkId: string): Promise<boolean> {
        return this.deps.store.hasWaitingJob(linkId, this.deps.now());
    }

    private overdue(pass: Pass): boolean {
        return this.deps.now().getTime() >= pass.deadline;
    }

    // ---- apply: copy

    /**
     * Jobs with the same key send through the same webhook, so they never
     * run at once. A channel's gap pass sends through its bridge webhook,
     * which its threads' jobs share. An archive job always sends through
     * its own import webhook.
     */
    private webhookKey(job: HistoryJob): string {
        if (job.kind === 'thread') return `parent:${job.parentDiscordId}`;
        return job.status === 'ready' && !job.archiveThreadId
            ? `parent:${job.discordId}`
            : `own:${job.id}`;
    }

    /** Jobs that can run now. Bridged channels finish with a gap pass. */
    private async runnable(jobs: HistoryJob[]) {
        const ready: HistoryJob[] = [];
        const now = this.deps.now().getTime();
        for (const job of jobs) {
            if (!job.fluxerId) continue;
            if (job.retryAt && job.retryAt.getTime() > now) continue;
            if (job.kind === 'channel') {
                const next = await this.channelRunnable(job);
                if (next) ready.push(next);
                continue;
            }
            if (job.status !== 'pending' && job.status !== 'importing')
                continue;
            if (
                job.parentDiscordId &&
                (await this.deps.links.byDiscordChannel(job.parentDiscordId))
            ) {
                ready.push(job);
            }
        }
        return ready;
    }

    /**
     * A channel copies through its import webhook until it is bridged,
     * then the gap pass copies the rest through the bridge. A channel
     * bridged before its import began copies its earlier history into an
     * archive thread instead (beginBridged): a gap pass would put all of
     * it below the live messages.
     */
    private async channelRunnable(job: HistoryJob): Promise<HistoryJob | null> {
        if (job.status === 'done' || job.status === 'failed') return null;
        if (job.archiveThreadId) return this.archiveRunnable(job);
        const bridged = await this.deps.links.byDiscordChannel(job.discordId);
        if (!bridged) return job.status === 'ready' ? null : job;
        if (job.status === 'importing') return this.handOver(job);
        return job;
    }

    /**
     * An archive thread's history goes on through the import webhook. A
     * finished one waits as ready until its channel is bridged, then
     * copies up to the link (finishArchive). A pending one starts again
     * and reuses its thread (ArchiveThreads).
     */
    private async archiveRunnable(job: HistoryJob): Promise<HistoryJob | null> {
        // A pending job has a thread when a step after making it failed.
        if (job.status === 'importing' || job.status === 'pending') return job;
        if (job.status !== 'ready') return null;
        const bridged = await this.deps.links.byDiscordChannel(job.discordId);
        return bridged ? job : null;
    }

    /** The channel was bridged mid-import: the gap pass takes over. */
    private async handOver(job: HistoryJob): Promise<HistoryJob> {
        await this.setStatus(job, 'ready');
        return { ...job, status: 'ready' };
    }

    private async setStatus(job: HistoryJob, status: JobStatus) {
        await this.deps.store.updateJob(job.id, { status }, this.deps.now());
    }

    private async importAll(pass: Pass, jobs: HistoryJob[]): Promise<boolean> {
        const candidates = await this.runnable(jobs);
        const picked: HistoryJob[] = [];
        const keys = new Set<string>();
        for (const job of candidates) {
            if (picked.length >= MAX_PARALLEL) break;
            if (keys.has(this.webhookKey(job))) continue;
            keys.add(this.webhookKey(job));
            picked.push(job);
        }
        const results = await Promise.all(
            picked.map((job) => this.step(pass, job))
        );
        const more = candidates.length > picked.length || results.some(Boolean);
        if (!more) await this.reportDone(pass.link);
        return more;
    }

    private async reportDone(link: LinkedGuild) {
        const totals = await this.deps.store.jobTotals(link.id);
        if (totals.jobs === 0 || totals.open > 0) return;
        const { imported, skipped, failed } = totals;
        const text = `History import finished: ${imported} messages copied, ${skipped} messages skipped, ${failed} jobs failed.`;
        await this.deps.report(
            link.id,
            `done:${imported}:${skipped}:${failed}`,
            text
        );
    }

    /** Runs one job for one page. Returns true when it has more to do. */
    private async step(pass: Pass, job: HistoryJob): Promise<boolean> {
        try {
            if (job.status === 'ready' && !job.archiveThreadId)
                return await this.closeGap(pass, job);
            return await this.importPage(pass, job);
        } catch (error) {
            if (error instanceof StoppedError) return false;
            const fresh = (await this.deps.store.getJob(job.id)) ?? job;
            await this.onError(pass.link, fresh, error);
            return false;
        }
    }

    /**
     * A temporary error waits and retries without counting. A lasting one
     * counts; at MAX_FAILURES the message at fault is skipped, or the job
     * fails when no single message is at fault, such as when the webhook
     * or channel is gone or the bot lost access (isTargetError).
     */
    private async onError(link: LinkedGuild, job: HistoryJob, error: unknown) {
        const detail = describeError(error);
        this.deps.logger.warn(
            `[history] ${job.kind} ${job.discordId}: ${detail}`
        );
        if (isTransient(error)) return this.retryLater(job, detail);
        const failures = job.failures + 1;
        const patch = { ...this.lostWebhook(job, error), lastError: detail };
        if (failures < MAX_FAILURES) {
            const retryAt = new Date(
                this.deps.now().getTime() + backoffMs(failures)
            );
            await this.deps.store.updateJob(
                job.id,
                { ...patch, failures, retryAt },
                this.deps.now()
            );
            return;
        }
        if (error instanceof MessageError)
            await this.skip(link, job, error.messageId, detail);
        else await this.fail(link, job, detail, patch);
    }

    private async retryLater(job: HistoryJob, detail: string) {
        const { store, now } = this.deps;
        const retries = job.retries + 1;
        const retryAt = new Date(now().getTime() + backoffMs(retries));
        await store.updateJob(
            job.id,
            { retries, retryAt, lastError: detail },
            now()
        );
    }

    /**
     * Forgets a channel's import webhook once Fluxer no longer knows it,
     * so the next run makes a new one. A bridge webhook is the relay's.
     */
    private lostWebhook(job: HistoryJob, error: unknown): JobPatch {
        const ownHook =
            job.kind === 'channel' &&
            job.importWebhook !== null &&
            (job.status !== 'ready' || job.archiveThreadId !== null);
        return ownHook && isUnknownWebhook(error)
            ? { importWebhook: null }
            : {};
    }

    /**
     * Gives up on one message that keeps failing, and records it. After
     * MAX_SKIP_STREAK skips in a row the job fails: the trouble is then
     * likely not with the messages.
     */
    private async skip(
        link: LinkedGuild,
        job: HistoryJob,
        messageId: string,
        detail: string
    ) {
        const { store, now, logger } = this.deps;
        const skipStreak = job.skipStreak + 1;
        await store.dropMessage(messageId);
        await store.updateJob(
            job.id,
            {
                checkpointId: messageId,
                skipped: job.skipped + 1,
                skipStreak,
                failures: 0,
                retryAt: null,
                lastError: `skipped message ${messageId}: ${detail}`,
            },
            now()
        );
        logger.warn(
            `[history] Skipped message ${messageId} in ${job.kind} ${job.discordId}: ${detail}`
        );
        if (skipStreak < MAX_SKIP_STREAK) return;
        await this.fail(
            link,
            job,
            `${skipStreak} messages in a row could not be copied, the last one because: ${detail}`
        );
    }

    private async fail(
        link: LinkedGuild,
        job: HistoryJob,
        reason: string,
        patch: JobPatch = {}
    ) {
        await this.deps.store.updateJob(
            job.id,
            { ...patch, status: 'failed', lastError: reason },
            this.deps.now()
        );
        await this.deps.report(
            link.id,
            `failed:${job.id}`,
            `History import stopped for ${job.kind} ${job.discordId}: ${reason}`
        );
    }

    private async route(job: HistoryJob): Promise<Route> {
        const fluxerId = job.fluxerId ?? '';
        if (job.kind === 'thread') {
            const parentId = job.parentDiscordId ?? '';
            const parent = await this.deps.links.byDiscordChannel(parentId);
            if (!parent) throw new Error('the parent channel is not bridged');
            return {
                target: { webhook: parent.fluxerWebhook, threadId: fluxerId },
                relayHooks: await this.relayHooks(
                    parentId,
                    parent.discordWebhook.id
                ),
            };
        }
        // A channel bridged before its import began has a bridge already.
        const bridge = await this.deps.links.byDiscordChannel(job.discordId);
        const relayHooks = await this.relayHooks(
            job.discordId,
            bridge?.discordWebhook.id ?? null
        );
        const threadId = job.archiveThreadId;
        if (job.importWebhook) {
            return {
                target: { webhook: job.importWebhook, threadId },
                relayHooks,
            };
        }
        const webhook = await this.deps.ports.createImportWebhook(fluxerId);
        await this.deps.store.updateJob(
            job.id,
            { importWebhook: webhook },
            this.deps.now()
        );
        return { target: { webhook, threadId }, relayHooks };
    }

    /** The bridge webhook, if any, and earlier bridge webhooks still there. */
    private async relayHooks(
        discordChannelId: string,
        bridgeHook: string | null
    ): Promise<Set<string>> {
        const hooks = await this.deps.ports.bridgeWebhookIds(discordChannelId);
        if (bridgeHook) hooks.add(bridgeHook);
        return hooks;
    }

    /**
     * Sets the cutoff the import copies up to, and opens the archive
     * thread when the channel is big enough for archive-thread mode.
     * Returns null when the job ends without importing.
     */
    private async begin(
        pass: Pass,
        job: HistoryJob
    ): Promise<HistoryJob | null> {
        if (
            job.kind === 'channel' &&
            (await this.deps.links.byDiscordChannel(job.discordId))
        ) {
            return this.beginBridged(pass, job);
        }
        const cutoffId =
            (await this.deps.ports.newestMessageId(job.discordId)) ?? '0';
        const archiveThreadId = await this.archive.open(
            pass.link,
            job,
            pass.channelTypes.get(job.discordId),
            this.deps.now()
        );
        return this.started(job, cutoffId, archiveThreadId);
    }

    private async started(
        job: HistoryJob,
        cutoffId: string,
        archiveThreadId: string | null
    ): Promise<HistoryJob> {
        // lastError may hold a dry-run survey note.
        const patch = {
            status: 'importing' as const,
            cutoffId,
            archiveThreadId,
            lastError: null,
        };
        await this.deps.store.updateJob(job.id, patch, this.deps.now());
        return { ...job, ...patch };
    }

    /**
     * A channel bridged before its import began: history was turned on
     * after the channel was linked, or it was linked by hand. Its messages
     * from before the link go to an archive thread, so they never land
     * below live chat; newer ones are the relay's. Bridge posts and
     * messages the relay copied are skipped as always (skippable). Only a
     * channel whose Fluxer copy cannot hold a thread, such as a voice
     * channel, is marked done with a notice instead.
     */
    private async beginBridged(
        pass: Pass,
        job: HistoryJob
    ): Promise<HistoryJob | null> {
        const linkedAt =
            (await this.deps.ports.linkCreatedAt(job.discordId)) ??
            this.deps.now();
        const threadId = await this.archive.openForBridged(
            pass.link,
            job,
            pass.channelTypes.get(job.discordId),
            linkedAt
        );
        if (threadId)
            return this.started(job, snowflakeBefore(linkedAt), threadId);
        await this.skipBridged(pass.link, job);
        return null;
    }

    private async skipBridged(link: LinkedGuild, job: HistoryJob) {
        const reason =
            'history skipped: the channel was bridged before its history was copied, and its Fluxer channel cannot hold an archive thread';
        await this.deps.store.updateJob(
            job.id,
            { status: 'done', lastError: reason },
            this.deps.now()
        );
        await this.deps.report(
            link.id,
            `bridged:${job.id}`,
            `History import of ${job.kind} ${job.discordId}: ${reason}.`
        );
    }

    /**
     * A message that was sent but not recorded when the process stopped is
     * looked for among the last RECOVERY_SCAN Fluxer messages; otherwise
     * it is resent.
     */
    private async recover(job: HistoryJob) {
        const { store } = this.deps;
        const unfinished = await store.unfinishedMessage(job.id);
        if (!unfinished) return;
        const sent = await this.findSentCopy(unfinished);
        if (sent) await store.finishMessage(unfinished.discordMessageId, sent);
        else await store.dropMessage(unfinished.discordMessageId);
    }

    /**
     * The copy's Fluxer ID: a recent message from the same webhook that no
     * other record claims and whose text matches what was sent. The same
     * webhook also posts live relay messages, so neither alone is enough.
     */
    private async findSentCopy(
        unfinished: ImportedMessage
    ): Promise<string | null> {
        const recent = await this.deps.ports.recentFluxerMessages(
            unfinished.fluxerTargetId,
            RECOVERY_SCAN
        );
        const hash = unfinished.contentHash ?? null;
        for (const message of recent.slice(0, RECOVERY_SCAN)) {
            if (message.webhookId !== unfinished.webhookId) continue;
            if (hash !== null && contentHash(message.content) !== hash)
                continue;
            if (await this.claimed(message.id)) continue;
            return message.id;
        }
        return null;
    }

    /** True when an import or a relay already owns this Fluxer message. */
    private async claimed(fluxerMessageId: string): Promise<boolean> {
        const { store, ports } = this.deps;
        return (
            (await store.importedByFluxerId(fluxerMessageId)) !== null ||
            (await store.relayedInThreadByFluxerId(fluxerMessageId)) ||
            (await ports.relayedLiveFluxer(fluxerMessageId))
        );
    }

    private async importPage(pass: Pass, start: HistoryJob): Promise<boolean> {
        const job =
            start.status === 'pending' ? await this.begin(pass, start) : start;
        if (!job) return false;
        const route = await this.route(job);
        await this.recover(job);
        const cutoff = job.cutoffId ?? '0';
        const page = await this.deps.ports.listMessages(
            job.discordId,
            job.checkpointId,
            PAGE_SIZE
        );
        const end = await this.archiveEnd(job);
        const due = page.filter(
            (m) => !later(m.id, cutoff) && snowflakeTime(m.id) < end
        );
        if (due.length === 0) return this.finish(pass, job);
        return this.whileOpen(pass.link, job, () =>
            this.copyPage(pass, job, due, route)
        );
    }

    /**
     * Fluxer refuses webhook posts in a locked thread and unarchives an
     * archived one on its own (fluxer_api ThreadMessageActivity
     * beforeWebhookSend). A thread locked on Discord is unlocked only for
     * one page and locked again at once, so members cannot post there
     * while it is copied.
     */
    private async whileOpen(
        link: LinkedGuild,
        job: HistoryJob,
        work: () => Promise<boolean>
    ): Promise<boolean> {
        const threadId = await this.lockedThread(job);
        if (!threadId) return work();
        const { writer } = this.deps;
        await writer.updateThread(link.fluxerGuildId, threadId, {
            locked: false,
        });
        try {
            return await work();
        } finally {
            await writer.updateThread(link.fluxerGuildId, threadId, {
                locked: true,
            });
        }
    }

    /** The Fluxer thread a job writes to, when it is kept locked. */
    private async lockedThread(job: HistoryJob): Promise<string | null> {
        if (job.archiveThreadId) return job.archiveThreadId;
        if (job.kind !== 'thread' || !job.fluxerId) return null;
        const { locked } = await this.deps.ports.threadState(job.discordId);
        return locked ? job.fluxerId : null;
    }

    /**
     * An archive thread's history ends where the bridge begins: messages
     * from then on are relayed live. Without a bridge, there is no end.
     */
    private async archiveEnd(job: HistoryJob): Promise<number> {
        if (!job.archiveThreadId) return Number.POSITIVE_INFINITY;
        const linkedAt = await this.deps.ports.linkCreatedAt(job.discordId);
        return linkedAt ? linkedAt.getTime() : Number.POSITIVE_INFINITY;
    }

    private async copyPage(
        pass: Pass,
        job: HistoryJob,
        due: readonly SourceMessage[],
        route: Route
    ): Promise<boolean> {
        let state = job;
        for (const message of due) {
            if (this.overdue(pass)) return true;
            // Sent through the import webhook once linked, upstream would
            // relay the copy back to Discord.
            if (
                state.kind === 'channel' &&
                !state.archiveThreadId &&
                (await this.deps.links.byDiscordChannel(state.discordId))
            ) {
                await this.handOver(state);
                return true;
            }
            state = await this.copy(pass, state, message, route);
        }
        return true;
    }

    /** Messages a job never copies. */
    private async skippable(
        job: HistoryJob,
        message: SourceMessage,
        route: Route
    ): Promise<boolean> {
        if (!message.copyable) return true;
        // The sync posts a forum post's first message when it creates it.
        if (job.kind === 'thread' && message.id === job.discordId) return true;
        // Bridge webhooks, this one's or an earlier link's, post copies of
        // Fluxer messages; so does any webhook this bot's app owns.
        if (
            message.webhookId !== null &&
            (message.ownWebhook || route.relayHooks.has(message.webhookId))
        )
            return true;
        // The thread relay copied it live, either way.
        if (job.kind === 'thread')
            return this.deps.store.relayedInThread(message.id);
        // An archive thread copies up to the link; the relay may have
        // copied a message from just before it.
        return (
            job.archiveThreadId !== null &&
            (await this.deps.ports.relayedLive(message.id))
        );
    }

    /**
     * True when the message already has a copy. A copy whose send was cut
     * off is resolved first, so a restart neither repeats nor loses it.
     */
    private async alreadyCopied(job: HistoryJob, messageId: string) {
        const { store } = this.deps;
        const found = await store.importedByDiscordId(messageId);
        if (!found || found.fluxerMessageId || found.jobId !== job.id)
            return found !== null;
        await this.recover(job);
        return (await store.importedByDiscordId(messageId)) !== null;
    }

    /** Moves the checkpoint past a message without sending it. */
    private async advance(job: HistoryJob, messageId: string) {
        await this.deps.store.updateJob(
            job.id,
            { checkpointId: messageId },
            this.deps.now()
        );
        return { ...job, checkpointId: messageId };
    }

    /**
     * Copies one message and moves the checkpoint past it. Stops when
     * writes are switched off or another instance took the leader lock.
     * A send error counts against the message unless it is about the
     * target (isTargetError), which fails every message alike.
     */
    private async copy(
        pass: Pass,
        job: HistoryJob,
        message: SourceMessage,
        route: Route
    ): Promise<HistoryJob> {
        if ((await this.deps.mode(pass.link.id)) !== 'apply')
            throw new StoppedError();
        if (!(await pass.held())) throw new StoppedError();
        if (
            (await this.skippable(job, message, route)) ||
            (await this.alreadyCopied(job, message.id))
        ) {
            return this.advance(job, message.id);
        }
        try {
            return await this.sendOne(pass.link, job, message, route);
        } catch (error) {
            if (isTargetError(error)) throw error;
            throw new MessageError(message.id, error);
        }
    }

    /** Records, sends and checkpoints one copy. */
    private async sendOne(
        link: LinkedGuild,
        job: HistoryJob,
        message: SourceMessage,
        route: Route
    ): Promise<HistoryJob> {
        const { store, now } = this.deps;
        const payload = await this.formatter.build(message, link.id);
        const { target } = route;
        await store.startMessage(
            {
                discordMessageId: message.id,
                jobId: job.id,
                discordAuthorId: message.authorId,
                fluxerMessageId: null,
                fluxerTargetId: target.threadId ?? job.fluxerId ?? '',
                inThread: target.threadId !== null,
                webhookId: target.webhook.id,
                contentHash: contentHash(payload.content),
            },
            now()
        );
        const fluxerId = await this.send(target, payload, message.id);
        await store.finishMessage(message.id, fluxerId);
        const patch = {
            checkpointId: message.id,
            imported: job.imported + 1,
            failures: 0,
            retries: 0,
            skipStreak: 0,
            retryAt: null,
        };
        await store.updateJob(job.id, patch, now());
        await this.deps.pause(SEND_INTERVAL_MS);
        return { ...job, ...patch };
    }

    /**
     * Sends a copy. Only an upload refusal is retried, once, without the
     * files. After a temporary error the message stays recorded as
     * unfinished: the send may have gone through, and recovery checks
     * before anything is resent. Any other error definitely sent nothing.
     */
    private async send(
        target: SendTarget,
        payload: RelayPayload,
        discordId: string
    ): Promise<string> {
        try {
            return await this.deps.ports.sendCopy(target, payload);
        } catch (error) {
            const files = payload.attachments ?? [];
            if (files.length === 0 || !isUploadError(error)) {
                await this.forget(discordId, error);
                throw error;
            }
            return this.sendWithoutFiles(target, payload, discordId);
        }
    }

    private async sendWithoutFiles(
        target: SendTarget,
        payload: RelayPayload,
        discordId: string
    ): Promise<string> {
        const names = (payload.attachments ?? []).map((f) => f.name);
        const content = withNote(
            payload.content,
            `*Attachments not copied: ${names.join(', ')}*`
        );
        await this.deps.store.setContentHash(discordId, contentHash(content));
        try {
            return await this.deps.ports.sendCopy(target, {
                ...payload,
                attachments: [],
                content,
            });
        } catch (retry) {
            await this.forget(discordId, retry);
            throw retry;
        }
    }

    /** Drops the record of a send that surely failed. */
    private async forget(discordId: string, error: unknown) {
        if (!isTransient(error)) await this.deps.store.dropMessage(discordId);
    }

    /**
     * Pins the copies of messages pinned on Discord. Pins are a courtesy:
     * a failure is logged and never holds the import back.
     */
    private async pinCopies(job: HistoryJob): Promise<void> {
        const { store, ports, logger } = this.deps;
        try {
            const pinned = await ports.pinnedMessageIds(job.discordId);
            for (const id of pinned.slice(0, MAX_PINS)) {
                const copy = await store.importedByDiscordId(id);
                if (!copy?.fluxerMessageId) continue;
                await ports.pinCopy(copy.fluxerTargetId, copy.fluxerMessageId);
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : error;
            logger.warn(
                `[history] Pins of ${job.kind} ${job.discordId}: ${detail}`
            );
        }
    }

    /** Catches up on new messages, then waits for the bridge or finishes. */
    private async finish(pass: Pass, job: HistoryJob): Promise<boolean> {
        const { store, ports, now } = this.deps;
        if (job.archiveThreadId) return this.finishArchive(pass, job);
        if (await this.catchUp(job)) return true;
        await this.pinCopies(job);
        if (job.kind === 'channel') {
            // A channel that is never bridged has no gap to close.
            const status = pass.unbridged.has(job.discordId) ? 'done' : 'ready';
            await store.updateJob(job.id, { status }, now());
            return false;
        }
        const state = await ports.threadState(job.discordId);
        await this.deps.writer.updateThread(
            pass.link.fluxerGuildId,
            job.fluxerId ?? '',
            state
        );
        await this.deps.recordThreadState(pass.link.id, job.discordId, state);
        return this.done(job);
    }

    /** Moves the cutoff up to the newest message, MAX_CATCH_UPS times. */
    private async catchUp(job: HistoryJob): Promise<boolean> {
        const newest = await this.deps.ports.newestMessageId(job.discordId);
        if (!newest || !later(newest, job.cutoffId ?? '0')) return false;
        if (job.catchUps >= MAX_CATCH_UPS) return false;
        await this.deps.store.updateJob(
            job.id,
            { cutoffId: newest, catchUps: job.catchUps + 1 },
            this.deps.now()
        );
        return true;
    }

    /**
     * An archive thread's history ends where the bridge begins. Until the
     * channel is bridged it catches up like an inline import, then waits
     * as ready. Once bridged, the cutoff moves up to the link, so the
     * messages between the last catch-up and the link land in the archive
     * too, and only then does the thread close. A channel guild-sync can
     * never bridge closes at once.
     */
    private async finishArchive(pass: Pass, job: HistoryJob): Promise<boolean> {
        if (!(await this.deps.links.byDiscordChannel(job.discordId))) {
            if (await this.catchUp(job)) return true;
            if (pass.unbridged.has(job.discordId))
                return this.closeArchive(pass, job);
            if (job.status !== 'ready') await this.setStatus(job, 'ready');
            return false;
        }
        // Without a link time there is no fixed end to move up to.
        const linkedAt = await this.deps.ports.linkCreatedAt(job.discordId);
        if (!linkedAt) return this.closeArchive(pass, job);
        const cutoffId = snowflakeBefore(linkedAt);
        if (!later(cutoffId, job.cutoffId ?? '0'))
            return this.closeArchive(pass, job);
        await this.deps.store.updateJob(
            job.id,
            { status: 'importing', cutoffId },
            this.deps.now()
        );
        return true;
    }

    private async closeArchive(pass: Pass, job: HistoryJob): Promise<boolean> {
        await this.pinCopies(job);
        await this.archive.close(pass.link, job.archiveThreadId ?? '');
        return this.done(job);
    }

    /**
     * After the bridge exists, copies messages posted between the last
     * catch-up and the link, through the bridge's webhook (which the relay
     * never copies back). Only messages older than the link are copied:
     * newer ones are the relay's, including those still in its retry
     * queue. A gap longer than MAX_GAP_PAGES carries on in the next pass.
     */
    private async closeGap(pass: Pass, job: HistoryJob): Promise<boolean> {
        const bridge = await this.deps.links.byDiscordChannel(job.discordId);
        if (!bridge) return false;
        const linkedAt =
            (await this.deps.ports.linkCreatedAt(job.discordId)) ??
            this.deps.now();
        const route: Route = {
            target: { webhook: bridge.fluxerWebhook, threadId: null },
            relayHooks: await this.relayHooks(
                job.discordId,
                bridge.discordWebhook.id
            ),
        };
        await this.recover(job);
        let state = job;
        for (let page = 0; page < MAX_GAP_PAGES; page++) {
            const batch = await this.deps.ports.listMessages(
                job.discordId,
                state.checkpointId,
                PAGE_SIZE
            );
            for (const message of batch) {
                if (this.overdue(pass)) return true;
                if (snowflakeTime(message.id) >= linkedAt.getTime())
                    return this.done(state);
                state = (await this.deps.ports.relayedLive(message.id))
                    ? await this.advance(state, message.id)
                    : await this.copy(pass, state, message, route);
            }
            if (batch.length < PAGE_SIZE) return this.done(state);
        }
        return true;
    }

    private async done(job: HistoryJob): Promise<boolean> {
        await this.deps.store.updateJob(
            job.id,
            { status: 'done' },
            this.deps.now()
        );
        return false;
    }
}

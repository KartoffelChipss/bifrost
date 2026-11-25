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
    isTransient,
    isUploadError,
} from './errors';
import { CopyFormatter, contentHash, withNote } from './format';
import {
    MAX_PARALLEL,
    PAGE_SIZE,
    PASS_BUDGET_MS,
    SEND_INTERVAL_MS,
} from './limits';
import type { HistoryStore } from './store';
import { HistorySurvey } from './survey';
import type {
    HistoryJob,
    HistoryPorts,
    ImportedMessage,
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
/** Recent Fluxer messages searched for a copy cut off by a crash. */
export const RECOVERY_SCAN = 20;
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
    readonly writer: Pick<GuildWriter, 'updateThread'>;
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
}

/** Where a job's copies go, and the bridge whose Discord posts it skips. */
interface Route {
    readonly target: SendTarget;
    /** The bridge's Discord webhook: its posts are copies of Fluxer messages. */
    readonly bridgeHook: string | null;
}

const later = (a: string, b: string) => BigInt(a) > BigInt(b);

/** Discord's snowflake epoch: 2015-01-01T00:00:00Z. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** When a Discord snowflake was made, in ms since the Unix epoch. */
export function snowflakeTime(id: string): number {
    return Number(BigInt(id) >> BigInt(22)) + DISCORD_EPOCH_MS;
}

/** Stops a run cleanly when writes are switched off mid-way. */
class StoppedError extends Error {}

export class HistoryImporter {
    private readonly formatter: CopyFormatter;
    private readonly survey: HistorySurvey;

    constructor(private readonly deps: ImporterDeps) {
        this.formatter = new CopyFormatter(deps);
        this.survey = new HistorySurvey(deps);
    }

    /**
     * Creates a job for every source channel and thread, and maps targets.
     * Returns the jobs that may run: excluded channels and their threads
     * are left out, even when a job was created before they were excluded.
     */
    async planJobs(link: LinkedGuild): Promise<HistoryJob[]> {
        return (await this.plan(link)).jobs;
    }

    private async plan(link: LinkedGuild) {
        const { store, sync } = this.deps;
        const snapshot = await sync.lastSnapshot(link.id);
        const skip = snapshot
            ? excludedIds(snapshot, this.deps.excluded)
            : new Set(this.deps.excluded);
        if (snapshot) await this.createJobs(link, snapshot, skip);
        const jobs = await store.listJobs(link.id);
        // Guild-sync bridges every message channel type, unless the bot
        // cannot make the link there; such a channel has no gap to close.
        const unbridged = new Set(
            (snapshot?.channels ?? [])
                .filter(
                    (c) =>
                        !LINKED_CHANNEL_TYPES.has(c.type) ||
                        c.bridgeable === false
                )
                .map((c) => c.id)
        );
        return {
            jobs: jobs.filter((job) => !skip.has(job.discordId)),
            unbridged,
        };
    }

    private async createJobs(
        link: LinkedGuild,
        snapshot: GuildSnapshot,
        skip: ReadonlySet<string>
    ): Promise<void> {
        const { store, now } = this.deps;
        const known = new Set(
            (await store.listJobs(link.id)).map(
                (j) => `${j.kind}:${j.discordId}`
            )
        );
        for (const channel of snapshot.channels) {
            if (
                !MESSAGE_CHANNEL_TYPES.has(channel.type) ||
                skip.has(channel.id)
            ) {
                continue;
            }
            if (known.has(`channel:${channel.id}`)) continue;
            await store.ensureJob(link.id, 'channel', channel.id, null, now());
        }
        for (const thread of snapshot.threads) {
            if (known.has(`thread:${thread.id}`) || skip.has(thread.id))
                continue;
            await store.ensureJob(
                link.id,
                'thread',
                thread.id,
                thread.parentId,
                now()
            );
        }
        await this.mapTargets(link);
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
        for (const job of await store.listJobs(link.id)) {
            const fluxerId = target.get(`${job.kind}:${job.discordId}`);
            if (fluxerId && fluxerId !== job.fluxerId) {
                await store.updateJob(job.id, { fluxerId }, now());
            }
        }
    }

    /**
     * One pass for one guild link. In dry-run it counts messages; in apply
     * it copies them. Returns true when work is left for another pass.
     * No new message is started after `deadline` (ms).
     */
    async run(
        link: LinkedGuild,
        deadline = this.deps.now().getTime() + PASS_BUDGET_MS
    ): Promise<boolean> {
        const mode = await this.deps.mode(link.id);
        if (mode === 'read-only') return false;
        const { jobs, unbridged } = await this.plan(link);
        if (mode === 'dry-run') return this.survey.run(link, jobs, deadline);
        return this.importAll({ link, deadline, unbridged }, jobs);
    }

    /**
     * True while a job of this link waits for a time rather than for work:
     * a backoff after an error, or a copied channel waiting for its
     * bridge, whose gap pass should start soon after the link. The add-on
     * polls sooner than when idle.
     */
    async waiting(linkId: string): Promise<boolean> {
        const now = this.deps.now().getTime();
        const jobs = await this.deps.store.listJobs(linkId);
        return jobs.some(
            (j) =>
                (j.kind === 'channel' && j.status === 'ready') ||
                (j.status !== 'done' &&
                    j.status !== 'failed' &&
                    j.retryAt !== null &&
                    j.retryAt.getTime() > now)
        );
    }

    private overdue(pass: Pass): boolean {
        return this.deps.now().getTime() >= pass.deadline;
    }

    // ---- apply: copy

    /**
     * Jobs with the same key send through the same webhook, so they never
     * run at once. A channel's gap pass sends through its bridge webhook,
     * which its threads' jobs share.
     */
    private webhookKey(job: HistoryJob): string {
        if (job.kind === 'thread') return `parent:${job.parentDiscordId}`;
        return job.status === 'ready'
            ? `parent:${job.discordId}`
            : `own:${job.id}`;
    }

    /** Jobs that can run now. Bridged channels finish with a gap pass. */
    private async runnable(link: LinkedGuild, jobs: HistoryJob[]) {
        const ready: HistoryJob[] = [];
        const now = this.deps.now().getTime();
        for (const job of jobs) {
            if (!job.fluxerId) continue;
            if (job.retryAt && job.retryAt.getTime() > now) continue;
            if (job.kind === 'channel') {
                const next = await this.channelRunnable(link, job);
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
     * bridged before anything was copied fails instead: the gap pass
     * would put all of its history below the live messages.
     */
    private async channelRunnable(
        link: LinkedGuild,
        job: HistoryJob
    ): Promise<HistoryJob | null> {
        if (job.status === 'done' || job.status === 'failed') return null;
        const bridged = await this.deps.links.byDiscordChannel(job.discordId);
        if (!bridged) return job.status === 'ready' ? null : job;
        if (job.status === 'pending') {
            await this.fail(
                link,
                job,
                'the channel was bridged before its history was copied'
            );
            return null;
        }
        if (job.status === 'importing') return this.handOver(job);
        return job;
    }

    /** The channel was bridged mid-import: the gap pass takes over. */
    private async handOver(job: HistoryJob): Promise<HistoryJob> {
        await this.deps.store.updateJob(
            job.id,
            { status: 'ready' },
            this.deps.now()
        );
        return { ...job, status: 'ready' };
    }

    private async importAll(pass: Pass, jobs: HistoryJob[]): Promise<boolean> {
        const candidates = await this.runnable(pass.link, jobs);
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
        const jobs = await this.deps.store.listJobs(link.id);
        const waiting = jobs.filter(
            (j) => j.status !== 'done' && j.status !== 'failed'
        );
        if (jobs.length === 0 || waiting.length > 0) return;
        const copied = jobs.reduce((sum, j) => sum + j.imported, 0);
        const skipped = jobs.reduce((sum, j) => sum + j.skipped, 0);
        const failed = jobs.filter((j) => j.status === 'failed').length;
        const text = `History import finished: ${copied} messages copied, ${skipped} messages skipped, ${failed} jobs failed.`;
        await this.deps.report(
            link.id,
            `done:${copied}:${skipped}:${failed}`,
            text
        );
    }

    /** Runs one job for one page. Returns true when it has more to do. */
    private async step(pass: Pass, job: HistoryJob): Promise<boolean> {
        try {
            if (job.status === 'ready') return await this.closeGap(pass, job);
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
     * fails when no single message is at fault.
     */
    private async onError(link: LinkedGuild, job: HistoryJob, error: unknown) {
        const { store, now, logger } = this.deps;
        const detail = describeError(error);
        logger.warn(`[history] ${job.kind} ${job.discordId}: ${detail}`);
        if (isTransient(error)) {
            const retries = job.retries + 1;
            const retryAt = new Date(now().getTime() + backoffMs(retries));
            await store.updateJob(
                job.id,
                { retries, retryAt, lastError: detail },
                now()
            );
            return;
        }
        const failures = job.failures + 1;
        if (failures < MAX_FAILURES) {
            const retryAt = new Date(now().getTime() + backoffMs(failures));
            await store.updateJob(
                job.id,
                { failures, retryAt, lastError: detail },
                now()
            );
            return;
        }
        if (error instanceof MessageError)
            await this.skip(job, error.messageId, detail);
        else await this.fail(link, job, detail);
    }

    /** Gives up on one message that keeps failing, and records it. */
    private async skip(job: HistoryJob, messageId: string, detail: string) {
        const { store, now, logger } = this.deps;
        await store.dropMessage(messageId);
        await store.updateJob(
            job.id,
            {
                checkpointId: messageId,
                skipped: job.skipped + 1,
                failures: 0,
                retryAt: null,
                lastError: `skipped message ${messageId}: ${detail}`,
            },
            now()
        );
        logger.warn(
            `[history] Skipped message ${messageId} in ${job.kind} ${job.discordId}: ${detail}`
        );
    }

    private async fail(link: LinkedGuild, job: HistoryJob, reason: string) {
        await this.deps.store.updateJob(
            job.id,
            { status: 'failed', lastError: reason },
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
            const parent = await this.deps.links.byDiscordChannel(
                job.parentDiscordId ?? ''
            );
            if (!parent) throw new Error('the parent channel is not bridged');
            return {
                target: { webhook: parent.fluxerWebhook, threadId: fluxerId },
                bridgeHook: parent.discordWebhook.id,
            };
        }
        if (job.importWebhook) {
            return {
                target: { webhook: job.importWebhook, threadId: null },
                bridgeHook: null,
            };
        }
        const webhook = await this.deps.ports.createImportWebhook(fluxerId);
        await this.deps.store.updateJob(
            job.id,
            { importWebhook: webhook },
            this.deps.now()
        );
        return { target: { webhook, threadId: null }, bridgeHook: null };
    }

    /** Sets the cutoff, and opens an archived or locked thread for writing. */
    private async begin(
        link: LinkedGuild,
        job: HistoryJob
    ): Promise<HistoryJob> {
        const cutoffId =
            (await this.deps.ports.newestMessageId(job.discordId)) ?? '0';
        if (job.kind === 'thread' && job.fluxerId) {
            await this.deps.writer.updateThread(
                link.fluxerGuildId,
                job.fluxerId,
                {
                    archived: false,
                    locked: false,
                }
            );
        }
        // lastError may hold a dry-run survey note.
        await this.deps.store.updateJob(
            job.id,
            { status: 'importing', cutoffId, lastError: null },
            this.deps.now()
        );
        return { ...job, status: 'importing', cutoffId, lastError: null };
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
            start.status === 'pending'
                ? await this.begin(pass.link, start)
                : start;
        const route = await this.route(job);
        await this.recover(job);
        const cutoff = job.cutoffId ?? '0';
        const page = await this.deps.ports.listMessages(
            job.discordId,
            job.checkpointId,
            PAGE_SIZE
        );
        const due = page.filter((m) => !later(m.id, cutoff));
        if (due.length === 0) return this.finish(pass, job);
        let state = job;
        for (const message of due) {
            if (this.overdue(pass)) return true;
            // Sent through the import webhook once linked, upstream would
            // relay the copy back to Discord.
            if (
                state.kind === 'channel' &&
                (await this.deps.links.byDiscordChannel(state.discordId))
            ) {
                await this.handOver(state);
                return true;
            }
            state = await this.copy(pass.link, state, message, route);
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
        // The bridge's Discord webhook posts copies of Fluxer messages.
        if (
            message.webhookId !== null &&
            message.webhookId === route.bridgeHook
        )
            return true;
        // The thread relay copied it live, either way.
        return (
            job.kind === 'thread' &&
            (await this.deps.store.relayedInThread(message.id))
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

    /** Copies one message and moves the checkpoint past it. */
    private async copy(
        link: LinkedGuild,
        job: HistoryJob,
        message: SourceMessage,
        route: Route
    ): Promise<HistoryJob> {
        if ((await this.deps.mode(link.id)) !== 'apply')
            throw new StoppedError();
        if (
            (await this.skippable(job, message, route)) ||
            (await this.alreadyCopied(job, message.id))
        ) {
            return this.advance(job, message.id);
        }
        try {
            return await this.sendOne(link, job, message, route);
        } catch (error) {
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
        const newest = await ports.newestMessageId(job.discordId);
        if (
            newest &&
            later(newest, job.cutoffId ?? '0') &&
            job.catchUps < MAX_CATCH_UPS
        ) {
            await store.updateJob(
                job.id,
                { cutoffId: newest, catchUps: job.catchUps + 1 },
                now()
            );
            return true;
        }
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
            bridgeHook: bridge.discordWebhook.id,
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
                    : await this.copy(pass.link, state, message, route);
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

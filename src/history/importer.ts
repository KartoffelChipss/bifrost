import type { AddonLogger } from '../addons/isolation';
import type { LinkedGuild } from '../guild-sync/cycle';
import type { ChannelLinker, RelayPayload } from '../guild-sync/links';
import type { MapRow } from '../guild-sync/ops';
import type { GuildSnapshot } from '../guild-sync/snapshot';
import type { GuildWriter } from '../guild-sync/writers/writer';
import type { HistoryStore } from './store';
import type {
    HistoryJob,
    HistoryPorts,
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

/** Messages read per page, Discord's maximum. */
export const PAGE_SIZE = 100;
/** Fluxer allows 60 webhook messages a minute per webhook. */
export const SEND_INTERVAL_MS = 1_050;
/** Jobs copied at once, each through a different webhook. */
export const MAX_PARALLEL = 4;
/** Extra passes for messages posted while a channel was being copied. */
export const MAX_CATCH_UPS = 2;
/** A job stops after this many failed runs in a row. */
export const MAX_FAILURES = 5;
/** Pages read after a channel is bridged, to close the gap. */
export const MAX_GAP_PAGES = 5;
/** Jobs counted per dry-run pass, and pages per job. */
export const SURVEY_PER_RUN = 10;
export const SURVEY_MAX_PAGES = 200;
export const SURVEY_MAX_AGE_MS = 24 * 60 * 60_000;

/** Channel types with their own messages: text and announcement. */
const MESSAGE_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5]);

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

const later = (a: string, b: string) => BigInt(a) > BigInt(b);

function dateNote(when: Date): string {
    const stamp = when.toISOString().slice(0, 16).replace('T', ' ');
    return `*Originally posted ${stamp} UTC*`;
}

/** The copy carries its original time, which Fluxer cannot set. */
export function withDate(payload: RelayPayload, when: Date): RelayPayload {
    const note = dateNote(when);
    return {
        ...payload,
        content: payload.content ? `${payload.content}\n${note}` : note,
    };
}

export function optOutPayload(when: Date): RelayPayload {
    return {
        content: `*A message from a member who opted out of history import.*\n${dateNote(when)}`,
        username: 'Member',
        avatarURL: '',
    };
}

/** Stops a run cleanly when writes are switched off mid-way. */
class StoppedError extends Error {}

export class HistoryImporter {
    constructor(private readonly deps: ImporterDeps) {}

    /** Creates a job for every source channel and thread, and maps targets. */
    async planJobs(link: LinkedGuild): Promise<HistoryJob[]> {
        const { store, sync, now } = this.deps;
        const snapshot = await sync.lastSnapshot(link.id);
        if (!snapshot) return store.listJobs(link.id);
        const known = new Set(
            (await store.listJobs(link.id)).map(
                (j) => `${j.kind}:${j.discordId}`
            )
        );
        for (const channel of snapshot.channels) {
            if (!MESSAGE_CHANNEL_TYPES.has(channel.type)) continue;
            if (known.has(`channel:${channel.id}`)) continue;
            await store.ensureJob(link.id, 'channel', channel.id, null, now());
        }
        for (const thread of snapshot.threads) {
            if (known.has(`thread:${thread.id}`)) continue;
            await store.ensureJob(
                link.id,
                'thread',
                thread.id,
                thread.parentId,
                now()
            );
        }
        await this.mapTargets(link);
        return store.listJobs(link.id);
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
     */
    async run(link: LinkedGuild): Promise<boolean> {
        const mode = await this.deps.mode(link.id);
        if (mode === 'read-only') return false;
        const jobs = await this.planJobs(link);
        return mode === 'dry-run'
            ? this.survey(link, jobs)
            : this.importAll(link, jobs);
    }

    // ---- dry-run: count what would be copied

    private async count(job: HistoryJob) {
        let after = '0';
        let messages = 0;
        let attachments = 0;
        for (let page = 0; page < SURVEY_MAX_PAGES; page++) {
            const batch = await this.deps.ports.listMessages(
                job.discordId,
                after,
                PAGE_SIZE
            );
            for (const m of batch) {
                if (!m.copyable || m.id === job.discordId) continue;
                messages += 1;
                attachments += m.attachments;
            }
            if (batch.length < PAGE_SIZE) break;
            after = batch[batch.length - 1].id;
        }
        return { messages, attachments };
    }

    private async survey(
        link: LinkedGuild,
        jobs: HistoryJob[]
    ): Promise<boolean> {
        const { store, now } = this.deps;
        const stale = (j: HistoryJob) =>
            !j.surveyedAt ||
            now().getTime() - j.surveyedAt.getTime() > SURVEY_MAX_AGE_MS;
        const due = jobs.filter(stale);
        for (const job of due.slice(0, SURVEY_PER_RUN)) {
            const { messages, attachments } = await this.count(job);
            await store.updateJob(
                job.id,
                {
                    messageCount: messages,
                    attachmentCount: attachments,
                    surveyedAt: now(),
                },
                now()
            );
        }
        if (due.length > SURVEY_PER_RUN) return true;
        await this.reportSurvey(link, await store.listJobs(link.id));
        return false;
    }

    private async reportSurvey(link: LinkedGuild, jobs: HistoryJob[]) {
        const total = (
            kind: string,
            field: 'messageCount' | 'attachmentCount'
        ) =>
            jobs
                .filter((j) => j.kind === kind)
                .reduce((sum, j) => sum + (j[field] ?? 0), 0);
        const channelMessages = total('channel', 'messageCount');
        const threadMessages = total('thread', 'messageCount');
        const attachments =
            total('channel', 'attachmentCount') +
            total('thread', 'attachmentCount');
        const minutes = Math.ceil(
            ((channelMessages + threadMessages) * SEND_INTERVAL_MS) /
                MAX_PARALLEL /
                60_000
        );
        const text = [
            'History import (dry-run)',
            `Channels: ${jobs.filter((j) => j.kind === 'channel').length}, ${channelMessages} messages`,
            `Posts and threads: ${jobs.filter((j) => j.kind === 'thread').length}, ${threadMessages} replies`,
            `Attachments: ${attachments}`,
            `Estimated run time: about ${minutes} minutes at full parallelism`,
        ].join('\n');
        this.deps.logger.info(`[history] ${text}`);
        await this.deps.report(link.id, `survey:${text}`, text);
    }

    // ---- apply: copy

    private webhookKey(job: HistoryJob): string {
        return job.kind === 'channel'
            ? `own:${job.id}`
            : `parent:${job.parentDiscordId}`;
    }

    /** Jobs that can run now. Bridged channels finish with a gap pass. */
    private async runnable(link: LinkedGuild, jobs: HistoryJob[]) {
        const ready: HistoryJob[] = [];
        for (const job of jobs) {
            if (!job.fluxerId) continue;
            if (job.kind === 'channel') {
                const bridged = await this.deps.links.byDiscordChannel(
                    job.discordId
                );
                if (job.status === 'ready' && bridged) ready.push(job);
                else if (
                    bridged &&
                    job.status !== 'done' &&
                    job.status !== 'failed'
                ) {
                    await this.fail(
                        link,
                        job,
                        'the channel was bridged before its history was copied'
                    );
                } else if (
                    job.status === 'pending' ||
                    job.status === 'importing'
                ) {
                    ready.push(job);
                }
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

    private async importAll(
        link: LinkedGuild,
        jobs: HistoryJob[]
    ): Promise<boolean> {
        const candidates = await this.runnable(link, jobs);
        const picked: HistoryJob[] = [];
        const keys = new Set<string>();
        for (const job of candidates) {
            if (picked.length >= MAX_PARALLEL) break;
            if (keys.has(this.webhookKey(job))) continue;
            keys.add(this.webhookKey(job));
            picked.push(job);
        }
        const results = await Promise.all(
            picked.map((job) => this.step(link, job))
        );
        const more = candidates.length > picked.length || results.some(Boolean);
        if (!more) await this.reportDone(link);
        return more;
    }

    private async reportDone(link: LinkedGuild) {
        const jobs = await this.deps.store.listJobs(link.id);
        const waiting = jobs.filter(
            (j) => j.status !== 'done' && j.status !== 'failed'
        );
        if (jobs.length === 0 || waiting.length > 0) return;
        const copied = jobs.reduce((sum, j) => sum + j.imported, 0);
        const failed = jobs.filter((j) => j.status === 'failed').length;
        const text = `History import finished: ${copied} messages copied, ${failed} jobs failed.`;
        await this.deps.report(link.id, `done:${copied}:${failed}`, text);
    }

    /** Runs one job for one page. Returns true when it has more to do. */
    private async step(link: LinkedGuild, job: HistoryJob): Promise<boolean> {
        try {
            if (job.status === 'ready') return await this.closeGap(link, job);
            return await this.importPage(link, job);
        } catch (error) {
            if (error instanceof StoppedError) return false;
            const detail =
                error instanceof Error ? error.message : String(error);
            const failures = job.failures + 1;
            if (failures >= MAX_FAILURES) await this.fail(link, job, detail);
            else
                await this.deps.store.updateJob(
                    job.id,
                    { failures, lastError: detail },
                    this.deps.now()
                );
            this.deps.logger.warn(
                `[history] ${job.kind} ${job.discordId}: ${detail}`
            );
            return false;
        }
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

    private async target(job: HistoryJob): Promise<SendTarget> {
        const fluxerId = job.fluxerId ?? '';
        if (job.kind === 'thread') {
            const parent = await this.deps.links.byDiscordChannel(
                job.parentDiscordId ?? ''
            );
            if (!parent) throw new Error('the parent channel is not bridged');
            return { webhook: parent.fluxerWebhook, threadId: fluxerId };
        }
        if (job.importWebhook)
            return { webhook: job.importWebhook, threadId: null };
        const webhook = await this.deps.ports.createImportWebhook(fluxerId);
        await this.deps.store.updateJob(
            job.id,
            { importWebhook: webhook },
            this.deps.now()
        );
        return { webhook, threadId: null };
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
        await this.deps.store.updateJob(
            job.id,
            { status: 'importing', cutoffId },
            this.deps.now()
        );
        return { ...job, status: 'importing', cutoffId };
    }

    /**
     * A message that was sent but not recorded when the process stopped is
     * found as the newest message from our webhook. Otherwise it is resent.
     */
    private async recover(job: HistoryJob, target: SendTarget) {
        const { store, ports } = this.deps;
        const unfinished = await store.unfinishedMessage(job.id);
        if (!unfinished) return;
        const newest = await ports.newestFluxerMessage(
            target.threadId ?? job.fluxerId ?? ''
        );
        const ours =
            newest &&
            newest.webhookId === target.webhook.id &&
            !(await store.importedByFluxerId(newest.id));
        if (ours && newest)
            await store.finishMessage(unfinished.discordMessageId, newest.id);
        else await store.dropMessage(unfinished.discordMessageId);
    }

    private async importPage(
        link: LinkedGuild,
        start: HistoryJob
    ): Promise<boolean> {
        const job =
            start.status === 'pending' ? await this.begin(link, start) : start;
        const target = await this.target(job);
        await this.recover(job, target);
        const cutoff = job.cutoffId ?? '0';
        const page = await this.deps.ports.listMessages(
            job.discordId,
            job.checkpointId,
            PAGE_SIZE
        );
        const due = page.filter((m) => !later(m.id, cutoff));
        if (due.length === 0) return this.finish(link, job);
        let state = job;
        for (const message of due) {
            state = await this.copy(link, state, message, target);
        }
        return true;
    }

    /** Copies one message and moves the checkpoint past it. */
    private async copy(
        link: LinkedGuild,
        job: HistoryJob,
        message: SourceMessage,
        target: SendTarget
    ): Promise<HistoryJob> {
        const { store, ports, now } = this.deps;
        if ((await this.deps.mode(link.id)) !== 'apply')
            throw new StoppedError();
        const starter = job.kind === 'thread' && message.id === job.discordId;
        if (!message.copyable || starter) {
            await store.updateJob(job.id, { checkpointId: message.id }, now());
            return { ...job, checkpointId: message.id };
        }
        const payload = (await store.isOptedOut(message.authorId))
            ? optOutPayload(message.createdAt)
            : withDate(
                  await ports.payload(message.raw, link.id),
                  message.createdAt
              );
        await store.startMessage(
            {
                discordMessageId: message.id,
                jobId: job.id,
                discordAuthorId: message.authorId,
                fluxerMessageId: null,
                fluxerTargetId: target.threadId ?? job.fluxerId ?? '',
                inThread: target.threadId !== null,
                webhookId: target.webhook.id,
            },
            now()
        );
        const fluxerId = await this.send(target, payload, message.id);
        await store.finishMessage(message.id, fluxerId);
        const next = {
            ...job,
            checkpointId: message.id,
            imported: job.imported + 1,
            failures: 0,
        };
        await store.updateJob(
            job.id,
            {
                checkpointId: next.checkpointId,
                imported: next.imported,
                failures: 0,
            },
            now()
        );
        await this.deps.pause(SEND_INTERVAL_MS);
        return next;
    }

    /** Sends a copy. A refused upload is retried once without its files. */
    private async send(
        target: SendTarget,
        payload: RelayPayload,
        discordId: string
    ) {
        const { store, ports } = this.deps;
        try {
            return await ports.sendCopy(target, payload);
        } catch (error) {
            const files = payload.attachments ?? [];
            if (files.length === 0) {
                await store.dropMessage(discordId);
                throw error;
            }
            const names = files.map((f) => f.name).join(', ');
            try {
                return await ports.sendCopy(target, {
                    ...payload,
                    attachments: [],
                    content: `${payload.content}\n*Attachments not copied: ${names}*`,
                });
            } catch (retry) {
                await store.dropMessage(discordId);
                throw retry;
            }
        }
    }

    /** Catches up on new messages, then waits for the bridge or finishes. */
    private async finish(link: LinkedGuild, job: HistoryJob): Promise<boolean> {
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
        if (job.kind === 'channel') {
            await store.updateJob(job.id, { status: 'ready' }, now());
            return false;
        }
        const state = await ports.threadState(job.discordId);
        await this.deps.writer.updateThread(
            link.fluxerGuildId,
            job.fluxerId ?? '',
            state
        );
        await store.updateJob(job.id, { status: 'done' }, now());
        return false;
    }

    /**
     * After the bridge exists, copies messages posted between the last
     * catch-up and the link, through the bridge's webhook (which the relay
     * never copies back). It stops at the first message the relay copied.
     */
    private async closeGap(
        link: LinkedGuild,
        job: HistoryJob
    ): Promise<boolean> {
        const bridge = await this.deps.links.byDiscordChannel(job.discordId);
        if (!bridge) return false;
        const target: SendTarget = {
            webhook: bridge.fluxerWebhook,
            threadId: null,
        };
        let state = job;
        for (let page = 0; page < MAX_GAP_PAGES; page++) {
            const batch = await this.deps.ports.listMessages(
                job.discordId,
                state.checkpointId,
                PAGE_SIZE
            );
            for (const message of batch) {
                if (await this.deps.ports.relayedLive(message.id))
                    return this.done(state);
                state = await this.copy(link, state, message, target);
            }
            if (batch.length < PAGE_SIZE) break;
        }
        return this.done(state);
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

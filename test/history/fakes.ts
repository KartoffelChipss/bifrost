import type { RelayPayload, WebhookRef } from '../../src/guild-sync/links';
import type {
    Fixup,
    FixupPatch,
    FixupStatus,
    MentionStore,
    ScannedMessage,
} from '../../src/history/mentionStore';
import type { HistoryStore } from '../../src/history/store';
import type {
    FluxerCopy,
    HistoryJob,
    HistoryPorts,
    ImportedMessage,
    JobKey,
    JobKind,
    JobPatch,
    JobTotals,
    PayloadOptions,
    SendTarget,
    SourceMessage,
} from '../../src/history/types';

/** History tables in memory. */
export class FakeHistoryStore implements HistoryStore {
    jobs: HistoryJob[] = [];
    messages: ImportedMessage[] = [];
    optOuts = new Set<string>();
    /** Discord message IDs the thread relay copied. */
    relayedThread = new Set<string>();
    /** Active thread pairs from guild-sync's map: Fluxer ID to Discord ID. */
    threadPairs = new Map<string, string>();
    /** Recorded mentions by Discord message ID; absent means not recorded. */
    mentions = new Map<string, string[]>();
    private seq = 0;

    /** Calls of each listing, by name. */
    readonly listings = new Map<string, number>();

    private count(name: string) {
        this.listings.set(name, (this.listings.get(name) ?? 0) + 1);
    }

    async listJobs(guildLinkId: string) {
        this.count('listJobs');
        return this.jobs.filter((j) => j.guildLinkId === guildLinkId);
    }

    async listOpenJobs(guildLinkId: string) {
        this.count('listOpenJobs');
        return this.jobs.filter(
            (j) =>
                j.guildLinkId === guildLinkId &&
                j.status !== 'done' &&
                j.status !== 'failed'
        );
    }

    async jobKeys(guildLinkId: string): Promise<JobKey[]> {
        this.count('jobKeys');
        return this.jobs
            .filter((j) => j.guildLinkId === guildLinkId)
            .map(({ id, kind, discordId, fluxerId }) => ({
                id,
                kind,
                discordId,
                fluxerId,
            }));
    }

    async jobTotals(guildLinkId: string): Promise<JobTotals> {
        const jobs = this.jobs.filter((j) => j.guildLinkId === guildLinkId);
        return {
            jobs: jobs.length,
            open: jobs.filter(
                (j) => j.status !== 'done' && j.status !== 'failed'
            ).length,
            imported: jobs.reduce((sum, j) => sum + j.imported, 0),
            skipped: jobs.reduce((sum, j) => sum + j.skipped, 0),
            failed: jobs.filter((j) => j.status === 'failed').length,
        };
    }

    async hasWaitingJob(guildLinkId: string, now: Date) {
        return this.jobs.some(
            (j) =>
                j.guildLinkId === guildLinkId &&
                ((j.kind === 'channel' && j.status === 'ready') ||
                    (j.status !== 'done' &&
                        j.status !== 'failed' &&
                        j.retryAt !== null &&
                        j.retryAt.getTime() > now.getTime()))
        );
    }

    async getJob(id: string) {
        return this.jobs.find((j) => j.id === id) ?? null;
    }

    async ensureJob(
        guildLinkId: string,
        kind: JobKind,
        discordId: string,
        parentDiscordId: string | null
    ) {
        if (this.jobs.some((j) => j.kind === kind && j.discordId === discordId))
            return;
        this.jobs.push({
            id: `job-${++this.seq}`,
            guildLinkId,
            kind,
            discordId,
            parentDiscordId,
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
        });
    }

    async updateJob(id: string, patch: JobPatch) {
        this.jobs = this.jobs.map((j) =>
            j.id === id ? { ...j, ...patch } : j
        );
    }

    job(discordId: string): HistoryJob {
        const job = this.jobs.find((j) => j.discordId === discordId);
        if (!job) throw new Error(`no job for ${discordId}`);
        return job;
    }

    async startMessage(message: ImportedMessage) {
        if (
            this.messages.some(
                (m) => m.discordMessageId === message.discordMessageId
            )
        ) {
            throw new Error('duplicate key');
        }
        this.messages.push(message);
    }

    async finishMessage(discordId: string, fluxerId: string) {
        this.messages = this.messages.map((m) =>
            m.discordMessageId === discordId
                ? { ...m, fluxerMessageId: fluxerId }
                : m
        );
    }

    async dropMessage(discordId: string) {
        this.messages = this.messages.filter(
            (m) => m.discordMessageId !== discordId
        );
        this.mentions.delete(discordId);
    }

    async recordMentions(discordId: string, userIds: readonly string[]) {
        if (!this.messages.some((m) => m.discordMessageId === discordId))
            return;
        this.mentions.set(discordId, [...userIds]);
    }

    /** The guild link of an imported message's job. */
    linkOf(message: ImportedMessage): string | undefined {
        return this.jobs.find((j) => j.id === message.jobId)?.guildLinkId;
    }

    async setContentHash(discordId: string, hash: string) {
        this.messages = this.messages.map((m) =>
            m.discordMessageId === discordId ? { ...m, contentHash: hash } : m
        );
    }

    /** Fluxer message IDs the thread relay sent. */
    relayedThreadFluxer = new Set<string>();

    async relayedInThreadByFluxerId(id: string) {
        return this.relayedThreadFluxer.has(id);
    }

    async unfinishedMessage(jobId: string) {
        return (
            this.messages.find(
                (m) => m.jobId === jobId && !m.fluxerMessageId
            ) ?? null
        );
    }

    async importedByFluxerId(fluxerId: string) {
        return (
            this.messages.find((m) => m.fluxerMessageId === fluxerId) ?? null
        );
    }

    async importedByDiscordId(discordId: string) {
        return (
            this.messages.find((m) => m.discordMessageId === discordId) ?? null
        );
    }

    async relayedInThread(discordId: string) {
        return this.relayedThread.has(discordId);
    }

    async channelsReadyToBridge(guildLinkId: string) {
        return new Set(
            this.jobs
                .filter(
                    (j) =>
                        j.guildLinkId === guildLinkId &&
                        j.kind === 'channel' &&
                        (j.status === 'ready' ||
                            j.status === 'done' ||
                            j.archiveThreadId !== null)
                )
                .map((j) => j.discordId)
        );
    }

    async isArchiveThread(id: string) {
        return this.jobs.some((j) => j.archiveThreadId === id);
    }

    async retryFailed(guildLinkId: string) {
        let count = 0;
        this.jobs = this.jobs.map((j) => {
            if (j.guildLinkId !== guildLinkId || j.status !== 'failed')
                return j;
            count += 1;
            return {
                ...j,
                status: j.cutoffId === null ? 'pending' : 'importing',
                failures: 0,
                retries: 0,
                failingId: null,
                skipStreak: 0,
                streakFromId: null,
                retryAt: null,
                lastError: null,
            };
        });
        return count;
    }

    async isOptedOut(id: string) {
        return this.optOuts.has(id);
    }

    async setOptOut(id: string, out: boolean, now?: Date) {
        if (now === undefined) throw new Error('setOptOut needs the time');
        if (out) this.optOuts.add(id);
        else this.optOuts.delete(id);
    }

    async threadImporting(fluxerThreadId: string) {
        const discordId = this.threadPairs.get(fluxerThreadId);
        return this.jobs.some(
            (j) =>
                j.kind === 'thread' &&
                (j.fluxerId === fluxerThreadId ||
                    (j.fluxerId === null && j.discordId === discordId)) &&
                (j.status === 'pending' || j.status === 'importing')
        );
    }
}

export interface Sent {
    readonly webhook: string;
    readonly threadId: string | null;
    readonly content: string;
    readonly files: number;
}

/** Discord history and Fluxer copies in memory. */
export class FakeHistoryPorts implements HistoryPorts {
    /** Discord messages by channel or thread, oldest first. */
    readonly discord = new Map<string, SourceMessage[]>();
    readonly sent: Sent[] = [];
    readonly threadStates = new Map<
        string,
        { archived: boolean; locked: boolean }
    >();
    readonly relayed = new Set<string>();
    /** Sends that fail while this is above zero, with `failure`. */
    failNext = 0;
    /** What a failing send throws: by default a temporary 503. */
    failure: unknown = Object.assign(new Error('Service Unavailable'), {
        statusCode: 503,
    });
    refuseFiles = false;
    webhooks = 0;
    private seq = 0;

    add(channelId: string, id: string, overrides: Partial<SourceMessage> = {}) {
        const list = this.discord.get(channelId) ?? [];
        list.push({
            id,
            authorId: 'author',
            createdAt: new Date('2024-03-01T18:22:00Z'),
            copyable: true,
            attachments: 0,
            webhookId: null,
            ownWebhook: false,
            reply: null,
            reactions: [],
            raw: { id, text: `message ${id}` },
            ...overrides,
        });
        this.discord.set(channelId, list);
    }

    async listMessages(id: string, afterId: string, limit: number) {
        this.listings.push(`${id} ${afterId} ${limit}`);
        const failure = this.listFailure;
        if (failure) {
            this.listFailure = null;
            throw failure;
        }
        return (this.discord.get(id) ?? [])
            .filter((m) => BigInt(m.id) > BigInt(afterId))
            .slice(0, limit);
    }

    /** Discord message reads by fetchMessage, as `channel/message`. */
    readonly fetches: string[] = [];
    /** Each listMessages call, as `channel after limit`. */
    readonly listings: string[] = [];
    /** What the next listMessages throws, once. */
    listFailure: unknown = null;

    async fetchMessage(id: string, messageId: string) {
        this.fetches.push(`${id}/${messageId}`);
        return (
            (this.discord.get(id) ?? []).find((m) => m.id === messageId) ?? null
        );
    }

    async newestMessageId(id: string) {
        const list = this.discord.get(id) ?? [];
        return list[list.length - 1]?.id ?? null;
    }

    /** The options of every payload built, in order. */
    readonly payloadOptions: PayloadOptions[] = [];

    async payload(
        raw: unknown,
        _linkId: string,
        options: PayloadOptions = {}
    ): Promise<RelayPayload> {
        this.payloadOptions.push(options);
        const message = raw as { text: string; files?: number };
        return {
            content: message.text,
            username: 'author',
            avatarURL: '',
            attachments: Array.from({ length: message.files ?? 0 }, (_, i) => ({
                url: `https://cdn.discordapp.com/f${i}`,
                name: `file${i}.png`,
            })),
        };
    }

    async sendCopy(target: SendTarget, payload: RelayPayload) {
        if (this.failNext > 0) {
            this.failNext -= 1;
            throw this.failure;
        }
        const files = payload.attachments?.length ?? 0;
        if (files > 0 && this.refuseFiles)
            throw Object.assign(new Error('File size too large'), {
                statusCode: 413,
                code: 'FILE_SIZE_TOO_LARGE',
            });
        this.sent.push({
            webhook: target.webhook.id,
            threadId: target.threadId,
            content: payload.content,
            files,
        });
        return `copy-${++this.seq}`;
    }

    readonly edits: string[] = [];

    async editCopy(target: SendTarget, messageId: string, content: string) {
        this.edits.push(`edit ${target.webhook.id} ${messageId} ${content}`);
    }

    async deleteCopy(target: SendTarget, messageId: string) {
        this.edits.push(`delete ${target.webhook.id} ${messageId}`);
    }

    /** Recent Fluxer messages, newest first, for crash recovery. */
    recentCopies: FluxerCopy[] = [];
    /** Fluxer message IDs the live relay sent (message_links). */
    readonly relayedFluxer = new Set<string>();

    async recentFluxerMessages(_id: string, limit: number) {
        return this.recentCopies.slice(0, limit);
    }

    async relayedLiveFluxer(id: string) {
        return this.relayedFluxer.has(id);
    }

    async createImportWebhook(fluxerChannelId: string): Promise<WebhookRef> {
        this.webhooks += 1;
        return { id: `import-${fluxerChannelId}`, token: 'secret' };
    }

    async threadState(id: string) {
        return this.threadStates.get(id) ?? { archived: false, locked: false };
    }

    /** Bridge webhooks found in each Discord channel, by name or owner. */
    readonly bridgeHooks = new Map<string, string[]>();

    async bridgeWebhookIds(id: string) {
        return new Set(this.bridgeHooks.get(id) ?? []);
    }

    /** When each channel was bridged; unset means far in the future. */
    readonly linkTimes = new Map<string, Date>();

    async linkCreatedAt(id: string) {
        return this.linkTimes.get(id) ?? new Date(8.64e15);
    }

    async relayedLive(id: string) {
        return this.relayed.has(id);
    }

    /** Finds a stored message by the ID in `raw`, with `raw` as given. */
    describe(raw: unknown): SourceMessage {
        const { id } = raw as { id: string };
        for (const list of this.discord.values()) {
            const found = list.find((m) => m.id === id);
            if (found) return { ...found, raw };
        }
        throw new Error(`no message ${id}`);
    }

    /** Pinned Discord message IDs by channel or thread, oldest pin first. */
    readonly pinned = new Map<string, string[]>();
    readonly pins: string[] = [];

    async pinnedMessageIds(id: string) {
        return this.pinned.get(id) ?? [];
    }

    async pinCopy(channelId: string, messageId: string) {
        this.pins.push(`${channelId} ${messageId}`);
    }
}

/** A fix-up row in memory, with the time it is due. */
export type FakeFixup = Fixup & { notBefore: Date };

const later = (a: string, b: string) => BigInt(a) > BigInt(b);
const byId = (
    a: { discordMessageId: string },
    b: { discordMessageId: string }
) => (later(a.discordMessageId, b.discordMessageId) ? 1 : -1);

/** Mention tables in memory, over a FakeHistoryStore's messages. */
export class FakeMentionStore implements MentionStore {
    fixups: FakeFixup[] = [];
    /** The time of the last fix-up write. */
    lastWrite: Date | null = null;
    /** Linked Discord users and when they linked (identity links). */
    readonly linked = new Map<string, Date>();

    constructor(private readonly history: FakeHistoryStore) {}

    private unrecorded(guildLinkId: string) {
        return this.history.messages
            .filter(
                (m) =>
                    m.fluxerMessageId &&
                    !this.history.mentions.has(m.discordMessageId) &&
                    this.history.linkOf(m) === guildLinkId
            )
            .sort(byId);
    }

    async scanJobs(guildLinkId: string, limit: number) {
        const ids = new Set(this.unrecorded(guildLinkId).map((m) => m.jobId));
        return [...ids].sort().slice(0, limit);
    }

    async unscanned(jobId: string, limit: number) {
        return this.history.messages
            .filter(
                (m) =>
                    m.jobId === jobId &&
                    m.fluxerMessageId &&
                    !this.history.mentions.has(m.discordMessageId)
            )
            .sort(byId)
            .slice(0, limit)
            .map((m) => ({
                discordMessageId: m.discordMessageId,
                discordAuthorId: m.discordAuthorId,
            }));
    }

    async recordScan(guildLinkId: string, scanned: readonly ScannedMessage[]) {
        const first = new Map<string, bigint>();
        for (const entry of scanned) {
            this.history.mentions.set(entry.discordMessageId, [
                ...entry.discordUserIds,
            ]);
            const id = BigInt(entry.discordMessageId);
            for (const user of entry.discordUserIds) {
                const seen = first.get(user);
                if (seen === undefined || id < seen) first.set(user, id);
            }
        }
        this.fixups = this.fixups.map((f) => {
            const at = first.get(f.discordUserId);
            if (f.guildLinkId !== guildLinkId || at === undefined) return f;
            if (BigInt(f.doneTo) < at) return f;
            return {
                ...f,
                status: 'pending',
                doneTo: (at - BigInt(1)).toString(),
                changed: f.status === 'pending' ? f.changed : 0,
                failures: 0,
            };
        });
    }

    async abandonScan(jobId: string) {
        for (const m of this.history.messages) {
            if (m.jobId !== jobId || !m.fluxerMessageId) continue;
            if (!this.history.mentions.has(m.discordMessageId))
                this.history.mentions.set(m.discordMessageId, []);
        }
    }

    async scanLeft(guildLinkId: string) {
        return this.unrecorded(guildLinkId).length > 0;
    }

    async ensureFixups(
        guildLinkIds: readonly string[],
        discordUserId: string | null,
        notBefore: Date,
        now?: Date
    ) {
        if (now) this.lastWrite = now;
        let written = 0;
        for (const guildLinkId of guildLinkIds) {
            for (const [user, linkedAt] of this.linked) {
                if (discordUserId !== null && user !== discordUserId) continue;
                if (this.ensureOne(guildLinkId, user, linkedAt, notBefore))
                    written += 1;
            }
        }
        return written;
    }

    private ensureOne(
        guildLinkId: string,
        discordUserId: string,
        linkedAt: Date,
        notBefore: Date
    ): boolean {
        const fresh: FakeFixup = {
            guildLinkId,
            discordUserId,
            linkedAt,
            status: 'pending',
            doneTo: '0',
            changed: 0,
            failures: 0,
            notBefore,
        };
        const at = this.fixups.findIndex(
            (f) =>
                f.guildLinkId === guildLinkId &&
                f.discordUserId === discordUserId
        );
        if (at < 0) {
            this.fixups.push(fresh);
            return true;
        }
        if (this.fixups[at].linkedAt.getTime() === linkedAt.getTime())
            return false;
        this.fixups[at] = fresh;
        return true;
    }

    async dueFixups(
        guildLinkId: string,
        statuses: readonly FixupStatus[],
        now: Date,
        limit: number
    ) {
        return this.fixups
            .filter(
                (f) =>
                    f.guildLinkId === guildLinkId &&
                    statuses.includes(f.status) &&
                    f.notBefore.getTime() <= now.getTime() &&
                    this.linked.get(f.discordUserId)?.getTime() ===
                        f.linkedAt.getTime()
            )
            .slice(0, limit);
    }

    async copiesMentioning(
        guildLinkId: string,
        discordUserId: string,
        afterId: string,
        limit: number
    ) {
        return this.history.messages
            .filter(
                (m) =>
                    m.fluxerMessageId &&
                    this.history.linkOf(m) === guildLinkId &&
                    (
                        this.history.mentions.get(m.discordMessageId) ?? []
                    ).includes(discordUserId) &&
                    later(m.discordMessageId, afterId)
            )
            .sort(byId)
            .slice(0, limit);
    }

    async saveFixup(fixup: Fixup, patch: FixupPatch, now?: Date) {
        if (now) this.lastWrite = now;
        this.fixups = this.fixups.map((f) =>
            f.guildLinkId === fixup.guildLinkId &&
            f.discordUserId === fixup.discordUserId &&
            f.linkedAt.getTime() === fixup.linkedAt.getTime()
                ? { ...f, ...patch }
                : f
        );
    }

    fixup(discordUserId: string, guildLinkId = 'link-1'): FakeFixup {
        const found = this.fixups.find(
            (f) =>
                f.discordUserId === discordUserId &&
                f.guildLinkId === guildLinkId
        );
        if (!found) throw new Error(`no fix-up for ${discordUserId}`);
        return found;
    }
}

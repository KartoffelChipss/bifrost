import type { RelayPayload, WebhookRef } from '../../src/guild-sync/links';
import type { HistoryStore } from '../../src/history/store';
import type {
    HistoryJob,
    HistoryPorts,
    ImportedMessage,
    JobKind,
    JobPatch,
    SendTarget,
    SourceMessage,
} from '../../src/history/types';

/** History tables in memory. */
export class FakeHistoryStore implements HistoryStore {
    jobs: HistoryJob[] = [];
    messages: ImportedMessage[] = [];
    optOuts = new Set<string>();
    private seq = 0;

    async listJobs(guildLinkId: string) {
        return this.jobs.filter((j) => j.guildLinkId === guildLinkId);
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
            messageCount: null,
            attachmentCount: null,
            surveyedAt: null,
            importWebhook: null,
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

    async isOptedOut(id: string) {
        return this.optOuts.has(id);
    }

    async setOptOut(id: string, out: boolean, now?: Date) {
        if (now === undefined) throw new Error('setOptOut needs the time');
        if (out) this.optOuts.add(id);
        else this.optOuts.delete(id);
    }

    async threadImporting(fluxerThreadId: string) {
        return this.jobs.some(
            (j) =>
                j.kind === 'thread' &&
                j.fluxerId === fluxerThreadId &&
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
    /** Sends that fail while this is above zero. */
    failNext = 0;
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
            raw: { id, text: `message ${id}` },
            ...overrides,
        });
        this.discord.set(channelId, list);
    }

    async listMessages(id: string, afterId: string, limit: number) {
        return (this.discord.get(id) ?? [])
            .filter((m) => BigInt(m.id) > BigInt(afterId))
            .slice(0, limit);
    }

    async newestMessageId(id: string) {
        const list = this.discord.get(id) ?? [];
        return list[list.length - 1]?.id ?? null;
    }

    async payload(raw: unknown): Promise<RelayPayload> {
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
            throw new Error('503');
        }
        const files = payload.attachments?.length ?? 0;
        if (files > 0 && this.refuseFiles) throw new Error('file too large');
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

    /** What the newest Fluxer message is, for crash recovery. */
    newestCopy: { id: string; webhookId: string | null } | null = null;

    async newestFluxerMessage() {
        return this.newestCopy;
    }

    async createImportWebhook(fluxerChannelId: string): Promise<WebhookRef> {
        this.webhooks += 1;
        return { id: `import-${fluxerChannelId}`, token: 'secret' };
    }

    async threadState(id: string) {
        return this.threadStates.get(id) ?? { archived: false, locked: false };
    }

    async relayedLive(id: string) {
        return this.relayed.has(id);
    }
}

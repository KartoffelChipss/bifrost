import type { ChannelLinker } from '../guild-sync/links';
import { closedThreadCode } from './errors';
import { clipContent, defuseMentions } from './format';
import { MAX_CONTENT_LENGTH } from './limits';
import type { HistoryStore } from './store';
import type {
    HistoryJob,
    HistoryPorts,
    ImportedMessage,
    SendTarget,
    ThreadFlags,
} from './types';

const EDITED_NOTE = '\n*Edited by its author*';

const OPEN: ThreadFlags = { archived: false, locked: false };

/**
 * Runs an edit. Returns null when it went through, or the code when
 * Fluxer refused it for a closed thread; any other error is thrown.
 */
async function refusedAsClosed(
    edit: () => Promise<void>
): Promise<string | null> {
    try {
        await edit();
        return null;
    } catch (error) {
        const code = closedThreadCode(error);
        if (code === null) throw error;
        return code;
    }
}

/**
 * What reopening a closed Fluxer thread for an edit needs. Fluxer refuses
 * webhook edits in an archived or locked thread (fluxer_api
 * ThreadMessageActivity assertWebhookCanEdit); deletes have no such check
 * (MessageDeleteService deleteWebhookMessage).
 */
export interface EditorThreads {
    /** The Discord thread's state now (HistoryPorts.threadState). */
    discordState(discordThreadId: string): Promise<ThreadFlags>;
    /** Sets a Fluxer thread's archived and locked flags. */
    setState(
        guildLinkId: string,
        fluxerThreadId: string,
        state: ThreadFlags
    ): Promise<void>;
}

/**
 * Edits and deletes imported copies for their authors. Neither platform can
 * change a message's author, but the copy was sent by our webhook, so the
 * bot can change it on the author's behalf once their accounts are linked.
 */
export class HistoryEditor {
    /**
     * Without `threads`, an edit in a closed thread fails as Fluxer
     * refuses it.
     */
    constructor(
        private readonly store: HistoryStore,
        private readonly links: ChannelLinker,
        private readonly ports: Pick<HistoryPorts, 'editCopy' | 'deleteCopy'>,
        private readonly threads?: EditorThreads
    ) {}

    /** The imported copy, when `discordUserId` wrote the original. */
    async ownCopy(
        fluxerMessageId: string,
        discordUserId: string
    ): Promise<ImportedMessage | null> {
        const copy = await this.store.importedByFluxerId(fluxerMessageId);
        return copy && copy.discordAuthorId === discordUserId ? copy : null;
    }

    private async jobOf(copy: ImportedMessage): Promise<HistoryJob> {
        const job = await this.store.getJob(copy.jobId);
        if (!job) throw new Error('the import job is gone');
        return job;
    }

    /** The webhook that sent the copy: the import webhook or the bridge's. */
    private async target(
        copy: ImportedMessage,
        job: HistoryJob
    ): Promise<SendTarget> {
        const threadId = copy.inThread ? copy.fluxerTargetId : null;
        if (job.importWebhook?.id === copy.webhookId) {
            return { webhook: job.importWebhook, threadId };
        }
        const channel =
            job.kind === 'thread' ? job.parentDiscordId : job.discordId;
        const bridge = await this.links.byDiscordChannel(channel ?? '');
        if (!bridge || bridge.fluxerWebhook.id !== copy.webhookId) {
            throw new Error('the webhook that sent this copy is gone');
        }
        return { webhook: bridge.fluxerWebhook, threadId };
    }

    /** Sets the author's new text, marked as edited. */
    async edit(copy: ImportedMessage, text: string): Promise<void> {
        await this.replace(copy, `${text}${EDITED_NOTE}`);
    }

    /**
     * Sets the copy's text, cut to Fluxer's limit, with @everyone and
     * @here defused. The last line, such as the date note or the edit
     * marker, is kept.
     */
    async replace(copy: ImportedMessage, content: string): Promise<void> {
        const job = await this.jobOf(copy);
        const target = await this.target(copy, job);
        const text = clipContent(defuseMentions(content), MAX_CONTENT_LENGTH);
        await this.whileEditable(copy, job, () =>
            this.ports.editCopy(target, copy.fluxerMessageId ?? '', text)
        );
    }

    async remove(copy: ImportedMessage): Promise<void> {
        const job = await this.jobOf(copy);
        await this.ports.deleteCopy(
            await this.target(copy, job),
            copy.fluxerMessageId ?? ''
        );
        await this.store.dropMessage(copy.discordMessageId);
    }

    /**
     * Runs an edit. When Fluxer refuses it because the copy's thread is
     * archived or locked, the thread is opened for the edit alone and
     * closed again as it was, even when the second try fails.
     */
    private async whileEditable(
        copy: ImportedMessage,
        job: HistoryJob,
        edit: () => Promise<void>
    ): Promise<void> {
        const threads = this.threads;
        if (!copy.inThread || !threads) return edit();
        const code = await refusedAsClosed(edit);
        if (code === null) return;
        const before = await this.stateBefore(threads, copy, job, code);
        const threadId = copy.fluxerTargetId;
        await threads.setState(job.guildLinkId, threadId, OPEN);
        try {
            await edit();
        } finally {
            await threads.setState(job.guildLinkId, threadId, before);
        }
    }

    /**
     * The thread's state before it was opened. Fluxer checks archived
     * before locked, so THREAD_LOCKED means not archived. An archived
     * thread is locked when its Discord thread is; an archive thread of
     * history is always kept locked.
     */
    private async stateBefore(
        threads: EditorThreads,
        copy: ImportedMessage,
        job: HistoryJob,
        code: string
    ): Promise<ThreadFlags> {
        if (code === 'THREAD_LOCKED') return { archived: false, locked: true };
        const imported =
            job.kind === 'thread' && job.fluxerId === copy.fluxerTargetId;
        if (!imported) return { archived: true, locked: true };
        const { locked } = await threads.discordState(job.discordId);
        return { archived: true, locked };
    }
}

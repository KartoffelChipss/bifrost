import type { ChannelLinker } from '../guild-sync/links';
import { clipContent, defuseMentions } from './format';
import { MAX_CONTENT_LENGTH } from './limits';
import type { HistoryStore } from './store';
import type { HistoryPorts, ImportedMessage, SendTarget } from './types';

const EDITED_NOTE = '\n*Edited by its author*';

/**
 * Edits and deletes imported copies for their authors. Neither platform can
 * change a message's author, but the copy was sent by our webhook, so the
 * bot can change it on the author's behalf once their accounts are linked.
 */
export class HistoryEditor {
    constructor(
        private readonly store: HistoryStore,
        private readonly links: ChannelLinker,
        private readonly ports: Pick<HistoryPorts, 'editCopy' | 'deleteCopy'>
    ) {}

    /** The imported copy, when `discordUserId` wrote the original. */
    async ownCopy(
        fluxerMessageId: string,
        discordUserId: string
    ): Promise<ImportedMessage | null> {
        const copy = await this.store.importedByFluxerId(fluxerMessageId);
        return copy && copy.discordAuthorId === discordUserId ? copy : null;
    }

    /** The webhook that sent the copy: the import webhook or the bridge's. */
    private async target(copy: ImportedMessage): Promise<SendTarget> {
        const job = await this.store.getJob(copy.jobId);
        if (!job) throw new Error('the import job is gone');
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
        await this.ports.editCopy(
            await this.target(copy),
            copy.fluxerMessageId ?? '',
            clipContent(defuseMentions(content), MAX_CONTENT_LENGTH)
        );
    }

    async remove(copy: ImportedMessage): Promise<void> {
        await this.ports.deleteCopy(
            await this.target(copy),
            copy.fluxerMessageId ?? ''
        );
        await this.store.dropMessage(copy.discordMessageId);
    }
}

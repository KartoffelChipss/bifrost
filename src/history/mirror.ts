import type { AddonLogger } from '../addons/isolation';
import type { HistoryEditor } from './editor';
import type { CopyFormatter } from './format';
import type { HistoryMode } from './importer';
import type { HistoryStore } from './store';
import type { HistoryPorts, ImportedMessage } from './types';

/**
 * Carries Discord edits and deletes over to imported copies. Messages the
 * live relays copied are theirs to mirror: they are never in the history
 * table, so this finds nothing for them.
 */

export interface MirrorDeps {
    readonly store: HistoryStore;
    readonly editor: Pick<HistoryEditor, 'replace' | 'remove'>;
    readonly formatter: Pick<CopyFormatter, 'build' | 'mentionsOf'>;
    readonly ports: Pick<HistoryPorts, 'describe'>;
    /** The link's mode now: copies change only in apply. */
    readonly mode: (linkId: string) => Promise<HistoryMode>;
    readonly logger: AddonLogger;
}

export class HistoryMirror {
    constructor(private readonly deps: MirrorDeps) {}

    /** The copy of a Discord message, when writes are on for its link. */
    private async writableCopy(
        discordMessageId: string
    ): Promise<{ copy: ImportedMessage; linkId: string } | null> {
        const { store, mode } = this.deps;
        const copy = await store.importedByDiscordId(discordMessageId);
        if (!copy?.fluxerMessageId) return null;
        const job = await store.getJob(copy.jobId);
        if (!job || (await mode(job.guildLinkId)) !== 'apply') return null;
        return { copy, linkId: job.guildLinkId };
    }

    /**
     * `load` returns the edited message, or null when the update was not an
     * edit. It runs only for a message that has a copy, as it may fetch.
     * An opted-out author's copy becomes the opt-out placeholder: the text
     * changes; the name and avatar a webhook edit cannot change.
     */
    async edited(
        discordMessageId: string,
        load: () => Promise<unknown>
    ): Promise<void> {
        await this.guarded('edit', async () => {
            const found = await this.writableCopy(discordMessageId);
            if (!found) return;
            // For an opted-out author the formatter gives the placeholder,
            // so an edit made to redact a message reaches the copy too.
            const raw = await load();
            if (raw === null || raw === undefined) return;
            const message = this.deps.ports.describe(raw);
            const { formatter, editor, store } = this.deps;
            const payload = await formatter.build(
                message,
                found.linkId,
                found.copy
            );
            await editor.replace(found.copy, payload.content);
            // The copy renders the edited text, so its mentions follow.
            await store.recordMentions(
                found.copy.discordMessageId,
                await formatter.mentionsOf(message)
            );
        });
    }

    async deleted(discordMessageId: string): Promise<void> {
        await this.guarded('delete', async () => {
            const found = await this.writableCopy(discordMessageId);
            if (found) await this.deps.editor.remove(found.copy);
        });
    }

    /**
     * A failure is logged here, so one bad message never counts against
     * the add-on's event-handler error budget (isolation.ts).
     */
    private async guarded(what: string, work: () => Promise<void>) {
        try {
            await work();
        } catch (error) {
            const detail = error instanceof Error ? error.message : error;
            this.deps.logger.warn(`[history] Mirroring a ${what}: ${detail}`);
        }
    }
}

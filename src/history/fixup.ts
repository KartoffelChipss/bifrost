import type { AddonLogger } from '../addons/isolation';
import type { RelayPayload } from '../guild-sync/links';
import { copyText, type HistoryEditor } from './editor';
import { describeError, isTransient } from './errors';
import {
    attachmentsNote,
    contentHash,
    withNote,
    type CopyFormatter,
} from './format';
import type { HistoryMode } from './importer';
import type {
    Fixup,
    FixupPatch,
    FixupStatus,
    MentionStore,
} from './mentionStore';
import type { WorkBudget } from './mentions';
import type { HistoryStore } from './store';
import type { HistoryPorts, ImportedMessage } from './types';

/**
 * Renders imported copies again once a member they mention links accounts:
 * a copy made before the link shows a plain @name, and fidelity maps the
 * mention only for linked members (relay-extras/fidelity). Each copy is
 * rebuilt exactly as the importer builds it (CopyFormatter) and edited
 * through HistoryEditor, which opens a closed thread for the edit, only
 * when the new text differs from the copy's recorded hash.
 *
 * A webhook edit never pings: Fluxer's editWebhookMessage stores the new
 * text without extracting mentions or running mention tasks (fluxer_api
 * MessageSendService editWebhookMessage, MessagePersistenceService
 * updateMessage), and the edit sends allowed_mentions `{ parse: [] }`
 * anyway (upstreamBridge editCopy).
 */

/**
 * Wait after each edit. Fluxer allows 30 webhook message edits a minute
 * per webhook (WebhookRateLimitConfig WEBHOOK_MESSAGE_EDIT).
 */
export const FIXUP_EDIT_INTERVAL_MS = 2_100;
/** Wait after each Discord read; discord.js waits out a 429 itself. */
export const FIXUP_READ_INTERVAL_MS = 250;
/** Copies read from the database at once. */
export const FIXUP_PAGE = 25;
/** Fix-ups one run starts. */
export const MAX_FIXUPS_PER_RUN = 5;
/** Temporary errors in a row on one copy before it is skipped. */
export const MAX_FIXUP_RETRIES = 10;
/** Upper bound on database pages one fix-up walks per run. */
const MAX_PAGES_PER_WALK = 40;

export interface FixupDeps {
    readonly mentions: Pick<
        MentionStore,
        'dueFixups' | 'copiesMentioning' | 'saveFixup' | 'scanLeft'
    >;
    readonly store: Pick<HistoryStore, 'getJob' | 'isOptedOut'>;
    readonly ports: Pick<HistoryPorts, 'fetchMessage'>;
    readonly formatter: Pick<CopyFormatter, 'build'>;
    readonly editor: Pick<HistoryEditor, 'replace'>;
    /** The link's mode now: copies change only in apply. */
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

/** What checking one copy came to. */
type Outcome = 'changed' | 'same' | 'stopped';

/** Where a walk stopped: out of budget, waiting for the backfill, done. */
type WalkEnd = 'more' | 'waiting' | 'finished';

/**
 * True when the copy already shows `payload`: its recorded hash matches
 * the text an edit would set, or that text with the note a copy sent
 * without its files carries (importer sendWithoutFiles).
 */
export function rendersAs(
    copy: ImportedMessage,
    payload: RelayPayload
): boolean {
    if (!copy.contentHash) return false;
    if (contentHash(copyText(payload.content)) === copy.contentHash)
        return true;
    const names = (payload.attachments ?? []).map((file) => file.name);
    if (names.length === 0) return false;
    const noted = withNote(
        payload.content,
        attachmentsNote(names),
        copy.native === true
    );
    return contentHash(noted) === copy.contentHash;
}

/** The admin notice when a fix-up finishes with copies changed. */
export function fixupNotice(
    discordUserId: string,
    changed: number,
    status: FixupStatus
): string {
    const copies = changed === 1 ? 'copy that mentions' : 'copies that mention';
    const what = `${changed} imported ${copies} <@${discordUserId}>, who linked their Fluxer account`;
    return status === 'done'
        ? `History: updated ${what}.`
        : `History (dry-run): would update ${what}. They are updated once the link is in apply.`;
}

const progress = (fixup: Fixup): FixupPatch => ({
    status: 'pending',
    doneTo: fixup.doneTo,
    changed: fixup.changed,
    failures: fixup.failures,
});

export class MentionFixups {
    constructor(private readonly deps: FixupDeps) {}

    /**
     * Runs the link's due fix-ups while the budget allows. In read-only
     * nothing runs; in dry-run copies are counted, not edited. Returns
     * true when work is left for a pass soon.
     */
    async run(
        guildLinkId: string,
        budget: WorkBudget,
        held: () => Promise<boolean>
    ): Promise<boolean> {
        const mode = await this.deps.mode(guildLinkId);
        if (mode === 'read-only') return false;
        const statuses: FixupStatus[] =
            mode === 'apply' ? ['pending', 'previewed'] : ['pending'];
        const due = await this.deps.mentions.dueFixups(
            guildLinkId,
            statuses,
            this.deps.now(),
            MAX_FIXUPS_PER_RUN
        );
        let finished = 0;
        for (const fixup of due) {
            const end = await this.walk(fixup, mode, budget, held);
            if (end === 'more') return true;
            if (end === 'finished') finished += 1;
        }
        return finished > 0 && due.length >= MAX_FIXUPS_PER_RUN;
    }

    /**
     * Checks the member's copies in Discord ID order from where the
     * fix-up stopped, saving progress after each. A dry-run preview is
     * checked again from the start in apply.
     */
    private async walk(
        fixup: Fixup,
        mode: HistoryMode,
        budget: WorkBudget,
        held: () => Promise<boolean>
    ): Promise<WalkEnd> {
        const restart = mode === 'apply' && fixup.status === 'previewed';
        let state: FixupPatch = restart
            ? { status: 'pending', doneTo: '0', changed: 0, failures: 0 }
            : progress(fixup);
        for (let page = 0; page < MAX_PAGES_PER_WALK; page++) {
            const copies = await this.deps.mentions.copiesMentioning(
                fixup.guildLinkId,
                fixup.discordUserId,
                state.doneTo,
                FIXUP_PAGE
            );
            if (copies.length === 0) return this.finish(fixup, state, mode);
            for (const copy of copies) {
                if (!budget.takeCopy()) return 'more';
                const next = await this.step(fixup, state, copy, mode, held);
                if (next === null) return 'more';
                state = next;
                await this.deps.mentions.saveFixup(fixup, state, this.now());
            }
        }
        return 'more';
    }

    private now(): Date {
        return this.deps.now();
    }

    /**
     * Checks one copy and returns the progress past it, or null when the
     * run stops before it: writes were switched off, the leader lock was
     * lost, or a temporary error will be retried.
     */
    private async step(
        fixup: Fixup,
        state: FixupPatch,
        copy: ImportedMessage,
        mode: HistoryMode,
        held: () => Promise<boolean>
    ): Promise<FixupPatch | null> {
        try {
            const outcome = await this.check(fixup, copy, mode, held);
            if (outcome === 'stopped') return null;
            const changed = state.changed + (outcome === 'changed' ? 1 : 0);
            return { ...state, doneTo: copy.discordMessageId, changed };
        } catch (error) {
            return this.failed(fixup, state, copy, error);
        }
    }

    /**
     * A temporary error is retried on a later pass, up to
     * MAX_FIXUP_RETRIES times in a row. Any other error, or one past the
     * retries, skips the copy: a deleted copy or source cannot be fixed.
     */
    private async failed(
        fixup: Fixup,
        state: FixupPatch,
        copy: ImportedMessage,
        error: unknown
    ): Promise<FixupPatch | null> {
        const failures = state.failures + 1;
        if (isTransient(error) && failures < MAX_FIXUP_RETRIES) {
            await this.deps.mentions.saveFixup(
                fixup,
                { ...state, failures },
                this.now()
            );
            return null;
        }
        this.deps.logger.warn(
            `[history] Skipped the mention fix-up of copy ${copy.fluxerMessageId ?? '?'}: ${describeError(error)}`
        );
        return { ...state, doneTo: copy.discordMessageId, failures: 0 };
    }

    /**
     * Rebuilds one copy and edits it when its text changes. An opted-out
     * author's copy, or one whose source is gone, is left as it is.
     */
    private async check(
        fixup: Fixup,
        copy: ImportedMessage,
        mode: HistoryMode,
        held: () => Promise<boolean>
    ): Promise<Outcome> {
        const { store, ports, formatter, editor, pause } = this.deps;
        if (await store.isOptedOut(copy.discordAuthorId)) return 'same';
        const job = await store.getJob(copy.jobId);
        if (!job) return 'same';
        const message = await ports.fetchMessage(
            job.discordId,
            copy.discordMessageId
        );
        await pause(FIXUP_READ_INTERVAL_MS);
        if (!message) return 'same';
        const payload = await formatter.build(message, fixup.guildLinkId, copy);
        if (rendersAs(copy, payload)) return 'same';
        if (mode !== 'apply') return 'changed';
        const writable =
            (await this.deps.mode(fixup.guildLinkId)) === 'apply' &&
            (await held());
        if (!writable) return 'stopped';
        await editor.replace(copy, payload.content);
        await pause(FIXUP_EDIT_INTERVAL_MS);
        return 'changed';
    }

    /**
     * Ends a walk that reached the last copy. While the link's backfill
     * still records mentions, the fix-up waits: a copy recorded later may
     * mention the member. Otherwise it is done, or previewed in dry-run,
     * and the admins hear how many copies changed.
     */
    private async finish(
        fixup: Fixup,
        state: FixupPatch,
        mode: HistoryMode
    ): Promise<WalkEnd> {
        const { mentions, logger } = this.deps;
        if (await mentions.scanLeft(fixup.guildLinkId)) {
            await mentions.saveFixup(fixup, state, this.now());
            return 'waiting';
        }
        const status: FixupStatus = mode === 'apply' ? 'done' : 'previewed';
        await mentions.saveFixup(fixup, { ...state, status }, this.now());
        logger.info(
            `[history] Mention fix-up for ${fixup.discordUserId} on guild link ${fixup.guildLinkId} ${status}: ${state.changed} copies changed`
        );
        if (state.changed === 0) return 'finished';
        await this.deps.report(
            fixup.guildLinkId,
            `mentions:${fixup.discordUserId}:${status}:${state.changed}`,
            fixupNotice(fixup.discordUserId, state.changed, status)
        );
        return 'finished';
    }
}

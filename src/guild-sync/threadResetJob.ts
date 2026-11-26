import type { AddonMode } from '../addons/config';
import { withTimeout } from '../addons/host';
import { UnrecordedWriteError, type AddonLogger } from '../addons/isolation';
import { isNotFound } from './apply';
import { resolveMode, type LinkedGuild } from './cycle';
import type { NoticeBoard } from './notices';
import {
    HISTORY_LOCK_KEY,
    THREAD_RESET_OP,
    type CopiedThread,
    type GuildSyncStore,
} from './store';
import { MAX_RESET_THREADS, stillCopied } from './threadReset';
import type { GuildWriter } from './writers/writer';

/**
 * Runs a confirmed `sync reset-threads` in the background (threadReset.ts
 * has the rules). It holds the guild-sync leader lock and the history
 * lock for the whole run, so no cycle can map or create a thread and no
 * history pass can import into one while it runs. Before every delete it
 * checks the lock, the kill switch and the mode, and stops when one
 * changed. Fluxer threads are deleted one at a time, about one a second.
 */

/** The wait between two deletes. */
export const RESET_PACE_MS = 1_000;
/** How often taking the locks is tried before the reset gives up. */
export const RESET_LOCK_ATTEMPTS = 60;
/** The wait between two tries: up to five minutes in all. */
export const RESET_LOCK_RETRY_MS = 5_000;
/** How long stopping guild-sync waits for a running reset. */
export const RESET_STOP_TIMEOUT_MS = 5_000;
/** The notice category of a reset's result. */
export const RESET_NOTICE_CATEGORY = 'thread-reset';

/**
 * Stops a reset without tripping read-only: rows of a thread that was
 * gone already could not be cleared, so nothing this run wrote is lost.
 */
export class ResetStoppedError extends Error {
    constructor(message: string, options: { cause: unknown }) {
        super(message);
        this.name = 'ResetStoppedError';
        Object.defineProperty(this, 'cause', { value: options.cause });
    }
}

/** What starting a reset did. */
export type ResetStart = 'started' | 'busy' | 'unavailable';

/** Starts a reset in the background. */
export interface ThreadResetLauncher {
    start(link: LinkedGuild, targets: readonly CopiedThread[]): ResetStart;
}

/**
 * Connects the `sync` command, built before the add-ons start, to the
 * reset runner guild-sync attaches while it runs. Made once at startup,
 * like StatusSignal. With no runner attached, a start is 'unavailable'.
 */
export class ThreadResetPort implements ThreadResetLauncher {
    private runner: ThreadResetLauncher | null = null;

    /** Sets the one runner. Returns a function that removes it. */
    attach(runner: ThreadResetLauncher): () => void {
        this.runner = runner;
        return () => {
            if (this.runner === runner) this.runner = null;
        };
    }

    start(link: LinkedGuild, targets: readonly CopiedThread[]): ResetStart {
        return this.runner?.start(link, targets) ?? 'unavailable';
    }
}

export interface ThreadResetDeps {
    readonly store: Pick<
        GuildSyncStore,
        | 'withLeaderLock'
        | 'loadSettings'
        | 'loadObjectMap'
        | 'forgetCopiedThread'
        | 'audit'
    >;
    readonly writer: Pick<GuildWriter, 'deleteThread'>;
    readonly notices: NoticeBoard;
    readonly processMode: () => AddonMode;
    readonly allowApply: boolean;
    /** Names this process in the leader lock row. */
    readonly holder: string;
    /**
     * Runs the reset inside the isolation boundary. Only an
     * UnrecordedWriteError leaves the runner: a Fluxer thread deleted
     * whose rows could not be forgotten trips read-only, as in apply.
     */
    readonly isolate: (run: () => Promise<void>) => Promise<unknown>;
    /** Called when a reset ended, so the status and next cycle follow. */
    readonly changed?: (guildLinkId: string) => void;
    readonly pause: (ms: number) => Promise<void>;
    readonly now: () => Date;
    /** A UUID: it groups the run's audit rows. */
    readonly newId: () => string;
    readonly logger: AddonLogger;
}

/** How a reset went. */
export interface ResetTally {
    readonly total: number;
    deleted: number;
    /** Fluxer answered 404: the thread was gone already. */
    gone: number;
    failed: number;
    /** No longer the same copied thread once the locks were taken. */
    changed: number;
    /** Why the reset stopped early, or null. */
    stopped: string | null;
    /** Threads not tried because the reset stopped. */
    left: number;
    /** False when the locks could not be taken: nothing was tried. */
    started: boolean;
}

function newTally(total: number): ResetTally {
    return {
        total,
        deleted: 0,
        gone: 0,
        failed: 0,
        changed: 0,
        stopped: null,
        left: total,
        started: false,
    };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The text of the notice a reset posts when it ends. */
export function describeResetResult(tally: ResetTally): string {
    if (!tally.started) {
        return `Thread reset did not start${tally.stopped ? `: ${tally.stopped}` : ''}. Nothing was deleted; run \`sync reset-threads\` again.`;
    }
    const changed =
        tally.changed > 0 ? `, ${tally.changed} skipped as changed` : '';
    const counts = `${tally.deleted} deleted, ${tally.gone} already gone, ${tally.failed} failed${changed}`;
    const lines = [
        tally.stopped
            ? `Thread reset stopped (${tally.stopped}): ${counts}, ${plural(tally.left, 'thread')} not tried.`
            : `Thread reset finished: ${counts}.`,
    ];
    if (tally.deleted + tally.gone > 0) {
        lines.push(
            'The next cycles create those threads again, and history import copies their messages.'
        );
    }
    if (tally.failed > 0 || tally.left > 0) {
        lines.push(
            'Threads not reset stay as they are; run `sync reset-threads` again for them.'
        );
    }
    return lines.join('\n');
}

/** Runs one reset at a time for guild-sync. */
export class ThreadResetRunner implements ThreadResetLauncher {
    private running: Promise<void> | null = null;
    private stopping = false;

    constructor(private readonly deps: ThreadResetDeps) {}

    start(link: LinkedGuild, targets: readonly CopiedThread[]): ResetStart {
        if (this.stopping) return 'unavailable';
        if (this.running) return 'busy';
        const runId = this.deps.newId();
        const work = targets.slice(0, MAX_RESET_THREADS);
        this.running = this.deps
            .isolate(() => this.execute(link, work, runId))
            .then(
                () => undefined,
                () => undefined
            )
            .finally(() => {
                this.running = null;
            });
        return 'started';
    }

    /** Resolves once no reset runs. */
    idle(): Promise<void> {
        return this.running ?? Promise.resolve();
    }

    /** Stops after the current thread. False if it did not end in time. */
    async stop(timeoutMs = RESET_STOP_TIMEOUT_MS): Promise<boolean> {
        this.stopping = true;
        if (!this.running) return true;
        return withTimeout(this.running, timeoutMs, 'thread reset').then(
            () => true,
            () => false
        );
    }

    private async execute(
        link: LinkedGuild,
        targets: readonly CopiedThread[],
        runId: string
    ): Promise<void> {
        const tally = newTally(targets.length);
        try {
            const ran = await this.withLocks((held) => {
                tally.started = true;
                return this.resetAll(link, targets, runId, tally, held);
            });
            if (!ran && !tally.stopped) {
                tally.stopped =
                    'a guild-sync cycle or history pass kept running';
            }
        } catch (error) {
            tally.stopped = error instanceof Error ? error.message : 'error';
            await this.report(link, tally, runId);
            if (error instanceof UnrecordedWriteError) throw error;
            this.deps.logger.error('[guild-sync] Thread reset failed:', error);
            return;
        }
        await this.report(link, tally, runId);
    }

    /**
     * Runs `fn` holding both locks, trying again while a cycle or history
     * pass holds one. False when they were never both free.
     */
    private async withLocks(
        fn: (held: () => Promise<boolean>) => Promise<void>
    ): Promise<boolean> {
        for (let attempt = 0; attempt < RESET_LOCK_ATTEMPTS; attempt++) {
            if (attempt > 0) await this.deps.pause(RESET_LOCK_RETRY_MS);
            if (this.stopping) return false;
            if (await this.tryLocks(fn)) return true;
        }
        return false;
    }

    private async tryLocks(
        fn: (held: () => Promise<boolean>) => Promise<void>
    ): Promise<boolean> {
        const { store, holder } = this.deps;
        const outer = await store.withLeaderLock(holder, async (syncHeld) => {
            const inner = await store.withLeaderLock(
                holder,
                (historyHeld) =>
                    fn(async () => (await syncHeld()) && (await historyHeld())),
                HISTORY_LOCK_KEY
            );
            return inner.ran;
        });
        return outer.ran && outer.value;
    }

    private async resetAll(
        link: LinkedGuild,
        targets: readonly CopiedThread[],
        runId: string,
        tally: ResetTally,
        held: () => Promise<boolean>
    ): Promise<void> {
        const rows = await this.deps.store.loadObjectMap(link.id);
        const current = stillCopied(rows, targets);
        tally.changed = targets.length - current.length;
        await this.resetEach(link, current, runId, tally, held);
    }

    private async resetEach(
        link: LinkedGuild,
        targets: readonly CopiedThread[],
        runId: string,
        tally: ResetTally,
        held: () => Promise<boolean>
    ): Promise<void> {
        tally.left = targets.length;
        for (const [i, target] of targets.entries()) {
            if (i > 0) await this.deps.pause(RESET_PACE_MS);
            const reason = await this.whyStop(link.id, held);
            if (reason) {
                tally.stopped = reason;
                return;
            }
            tally.left = targets.length - i - 1;
            await this.resetOne(link, target, runId, tally);
        }
    }

    /** Why the reset must stop before the next delete, or null. */
    private async whyStop(
        linkId: string,
        held: () => Promise<boolean>
    ): Promise<string | null> {
        if (this.stopping) return 'guild-sync is stopping';
        if (!(await held())) return 'the leader lock was lost';
        const { store, processMode, allowApply } = this.deps;
        const settings = await store.loadSettings(linkId);
        const mode = resolveMode(processMode(), settings, allowApply);
        if (mode.mode !== 'apply') {
            return mode.reason ?? `the link is now in ${mode.mode} mode`;
        }
        if (settings.direction !== 'discord-to-fluxer') {
            return 'Discord is no longer the source';
        }
        return null;
    }

    /** Deletes one Fluxer thread, then forgets it. A 404 counts as gone. */
    private async resetOne(
        link: LinkedGuild,
        target: CopiedThread,
        runId: string,
        tally: ResetTally
    ): Promise<void> {
        let gone = false;
        try {
            await this.deps.writer.deleteThread(
                link.fluxerGuildId,
                target.fluxerId
            );
        } catch (error) {
            if (!isNotFound(error)) {
                tally.failed += 1;
                await this.auditFailure(link, target, runId, error);
                return;
            }
            gone = true;
        }
        await this.forget(link, target, runId, gone);
        if (gone) tally.gone += 1;
        else tally.deleted += 1;
    }

    /**
     * Forgets a deleted thread. When that fails after this run deleted
     * the thread, the map points at nothing: an UnrecordedWriteError.
     */
    private async forget(
        link: LinkedGuild,
        target: CopiedThread,
        runId: string,
        gone: boolean
    ): Promise<void> {
        const { store, now } = this.deps;
        try {
            await store.forgetCopiedThread(
                link.id,
                target,
                { runId, gone },
                now()
            );
        } catch (error) {
            const what = `Fluxer thread ${target.fluxerId} is gone, but its rows could not be cleared; run the reset again`;
            if (!gone) throw new UnrecordedWriteError(what, { cause: error });
            throw new ResetStoppedError(what, { cause: error });
        }
    }

    private async auditFailure(
        link: LinkedGuild,
        target: CopiedThread,
        runId: string,
        error: unknown
    ): Promise<void> {
        const detail = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn(
            `[guild-sync] Thread reset could not delete Fluxer thread ${target.fluxerId}: ${detail}`
        );
        await this.deps.store.audit(
            {
                planId: runId,
                guildLinkId: link.id,
                op: THREAD_RESET_OP,
                kind: 'thread',
                sourceId: target.discordId,
                destId: target.fluxerId,
                before: null,
                after: { error: detail },
                result: 'failed',
            },
            this.deps.now()
        );
    }

    /** Logs the result and posts it to the admin channel. */
    private async report(
        link: LinkedGuild,
        tally: ResetTally,
        runId: string
    ): Promise<void> {
        const { store, notices, logger } = this.deps;
        const text = describeResetResult(tally);
        logger.info(`[guild-sync] Link ${link.id}: ${text}`);
        try {
            const { adminChannelId } = await store.loadSettings(link.id);
            await notices.post(
                link.id,
                RESET_NOTICE_CATEGORY,
                adminChannelId,
                runId,
                text
            );
        } catch (error) {
            logger.warn('[guild-sync] Could not post the reset result:', error);
        }
        this.deps.changed?.(link.id);
    }
}

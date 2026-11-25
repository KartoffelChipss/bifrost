import type { AddonModeController } from './mode';

/** The logging calls add-on code needs. Bifröst's winston logger fits it. */
export interface AddonLogger {
    info(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
}

export type IsolatedResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };

/**
 * A structure write that was made but could not be recorded, such as a
 * Discord thread created for a Fluxer one whose map row failed to save.
 * Ownership is unknown after it, so every add-on stops (guard 15), even
 * when it happens inside a live relay handler.
 */
export class UnrecordedWriteError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'UnrecordedWriteError';
        if (options && 'cause' in options) {
            Object.defineProperty(this, 'cause', { value: options.cause });
        }
    }
}

/** Live relay errors that pause one feature: this many... */
export const LIVE_FAILURE_LIMIT = 5;
/** ...within this window... */
export const LIVE_FAILURE_WINDOW_MS = 60_000;
/** ...pause it this long. It resumes on its own afterwards. */
export const LIVE_PAUSE_MS = 5 * 60_000;

/** What happens to one event of a live feature. */
export type LiveAdmission = 'run' | 'paused' | 'resumed';

/**
 * Counts errors per live relay feature (`addon/task`) and pauses a feature
 * that fails {@link LIVE_FAILURE_LIMIT} times within
 * {@link LIVE_FAILURE_WINDOW_MS}. A paused feature drops its events until
 * {@link LIVE_PAUSE_MS} has passed, then runs again with a clean count.
 * Features are named in code, so the maps stay small.
 */
export class LiveFailurePolicy {
    private readonly failures = new Map<string, number[]>();
    private readonly pausedUntil = new Map<string, number>();

    constructor(private readonly now: () => number = Date.now) {}

    /** Whether an event of `feature` may run now. */
    admit(feature: string): LiveAdmission {
        const until = this.pausedUntil.get(feature);
        if (until === undefined) return 'run';
        if (this.now() < until) return 'paused';
        this.pausedUntil.delete(feature);
        this.failures.delete(feature);
        return 'resumed';
    }

    /** Counts an error. Returns the recent count and whether it paused. */
    failed(feature: string): { count: number; paused: boolean } {
        const now = this.now();
        const recent = (this.failures.get(feature) ?? []).filter(
            (at) => now - at < LIVE_FAILURE_WINDOW_MS
        );
        recent.push(now);
        if (recent.length < LIVE_FAILURE_LIMIT) {
            this.failures.set(feature, recent);
            return { count: recent.length, paused: false };
        }
        this.failures.delete(feature);
        this.pausedUntil.set(feature, now + LIVE_PAUSE_MS);
        return { count: recent.length, paused: true };
    }

    isPaused(feature: string): boolean {
        const until = this.pausedUntil.get(feature);
        return until !== undefined && this.now() < until;
    }
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * The failure-isolation boundary between the relay and the add-ons
 * (safety guard 15). Nothing an add-on throws ever reaches the relay.
 *
 * Two failure policies:
 *
 * - {@link run}: add-on lifecycle and structure work (start, stop, sync
 *   cycles, import passes, sweeps). An unexpected error is logged and
 *   switches all add-ons to read-only until an admin or a restart clears
 *   it. A structure write that could not be recorded ends up here.
 * - {@link handler}: live relay event handlers (thread messages, reactions,
 *   pins, edits, DMs). An error is logged and counted per feature; only
 *   repeated errors pause that one feature, which resumes by itself (see
 *   {@link LiveFailurePolicy}). One bad event never stops the other
 *   features. An {@link UnrecordedWriteError} still trips read-only.
 */
export class IsolationBoundary {
    constructor(
        private readonly modeController: AddonModeController,
        private readonly logger: AddonLogger,
        readonly live: LiveFailurePolicy = new LiveFailurePolicy()
    ) {}

    /** Runs one add-on task. Errors from `fn` never escape. */
    async run<T>(
        addon: string,
        task: string,
        fn: () => Promise<T> | T
    ): Promise<IsolatedResult<T>> {
        try {
            return { ok: true, value: await fn() };
        } catch (error) {
            this.trip(addon, task, error);
            return { ok: false, error };
        }
    }

    /**
     * Wraps a live event listener so it can be passed to an event emitter.
     * The listener's promise is always handled inside the boundary.
     */
    handler<A extends unknown[]>(
        addon: string,
        task: string,
        fn: (...args: A) => Promise<void> | void
    ): (...args: A) => void {
        const feature = `${addon}/${task}`;
        return (...args: A) => {
            const admission = this.live.admit(feature);
            if (admission === 'paused') return;
            if (admission === 'resumed') {
                this.logger.info(`[addons] ${feature} resumed after a pause`);
            }
            void this.runLive(addon, task, () => fn(...args));
        };
    }

    private async runLive(
        addon: string,
        task: string,
        fn: () => Promise<void> | void
    ): Promise<void> {
        try {
            await fn();
        } catch (error) {
            if (error instanceof UnrecordedWriteError) {
                this.trip(addon, task, error);
                return;
            }
            this.countLive(`${addon}/${task}`, error);
        }
    }

    private countLive(feature: string, error: unknown): void {
        const { count, paused } = this.live.failed(feature);
        this.logger.error(
            `[addons] Error in ${feature} (${count} in the last minute):`,
            error
        );
        if (paused) {
            this.logger.error(
                `[addons] ${feature} paused for ${minutes(LIVE_PAUSE_MS)} minutes after ${count} errors. Other add-ons and the relay keep running.`
            );
        }
    }

    private trip(addon: string, task: string, error: unknown): void {
        const where = `${addon}/${task}`;
        const changed = this.modeController.tripReadOnly(
            `unexpected error in ${where}`
        );
        this.logger.error(`[addons] Unexpected error in ${where}:`, error);
        if (changed) {
            this.logger.error(
                `[addons] Add-ons switched to read-only after an error in ${where}. The relay keeps running.`
            );
        }
    }
}

import type { AddonLogger } from '../addons/isolation';

/**
 * Which cycle errors trip the add-ons to read-only.
 *
 * Rule: an error trips read-only only when a destination write happened
 * and its ownership or audit row could not be recorded (guard 15). Then
 * the database no longer describes what the bot owns, and any further
 * write could act on a wrong picture. Every other error (a database blip
 * while loading settings, taking the leader lock, listing links or saving
 * a plan) wrote nothing: it is logged, the cycle counts as failed, and
 * that link (or the whole run) waits out a backoff before it tries again.
 */

/** A write went through, but recording it failed (guard 15). */
export class OwnershipLostError extends Error {
    constructor(
        message: string,
        readonly cause: unknown
    ) {
        super(message);
        this.name = 'OwnershipLostError';
    }
}

/** The first wait after a failed cycle. Each further failure doubles it. */
export const FIRST_CYCLE_BACKOFF_MS = 60_000;
export const MAX_CYCLE_BACKOFF_MS = 30 * 60_000;
/** Bound on remembered keys: one per guild link plus the whole run. */
const MAX_KEYS = 1_000;

/** Failed cycles in a row, per key, and when the next try may run. */
export class CycleBackoff {
    private readonly entries = new Map<
        string,
        { count: number; until: number }
    >();

    blocked(key: string, now: number): boolean {
        const entry = this.entries.get(key);
        return entry !== undefined && entry.until > now;
    }

    /** Records a failure. Returns the wait before the next try. */
    failed(key: string, now: number): number {
        const count = (this.entries.get(key)?.count ?? 0) + 1;
        this.entries.delete(key);
        if (this.entries.size >= MAX_KEYS) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
        const steps = Math.min(count - 1, 10);
        const wait = Math.min(
            FIRST_CYCLE_BACKOFF_MS * 2 ** steps,
            MAX_CYCLE_BACKOFF_MS
        );
        this.entries.set(key, { count, until: now + wait });
        return wait;
    }

    succeeded(key: string): void {
        this.entries.delete(key);
    }
}

export type Guarded<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly reason: 'backoff' | 'failed' };

/**
 * Runs one cycle step under the rule above. An OwnershipLostError is
 * rethrown for the isolation boundary; any other error is logged and
 * backed off.
 */
export async function guardCycle<T>(
    key: string,
    deps: {
        readonly backoff: CycleBackoff;
        readonly now: () => Date;
        readonly logger: AddonLogger;
    },
    fn: () => Promise<T>
): Promise<Guarded<T>> {
    if (deps.backoff.blocked(key, deps.now().getTime())) {
        return { ok: false, reason: 'backoff' };
    }
    try {
        const value = await fn();
        deps.backoff.succeeded(key);
        return { ok: true, value };
    } catch (error) {
        if (error instanceof OwnershipLostError) throw error;
        const wait = deps.backoff.failed(key, deps.now().getTime());
        const detail = error instanceof Error ? error.message : String(error);
        deps.logger.error(
            `[guild-sync] Cycle ${key} failed: ${detail}. Retrying in ${Math.round(wait / 1000)}s; add-ons stay in their mode.`
        );
        return { ok: false, reason: 'failed' };
    }
}

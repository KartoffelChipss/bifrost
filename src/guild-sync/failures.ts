/**
 * Remembers ops that keep failing, so one broken object waits out a growing
 * backoff instead of taking a failure slot every cycle. Kept in memory: a
 * restart retries everything once, which is what an operator expects after
 * fixing a permission.
 */

/** Failures in a row before an op starts to wait. */
export const FAILURES_BEFORE_BACKOFF = 3;
/** The first wait. Each further failure doubles it. */
export const FIRST_BACKOFF_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 24 * 60 * 60_000;
/** Bound on remembered ops; the oldest entry goes first. */
export const MAX_ENTRIES = 5_000;

interface Entry {
    count: number;
    until: number;
}

export interface FailureLedger {
    /** True while the op waits out its backoff. */
    blocked(key: string, now: Date): boolean;
    failed(key: string, now: Date): void;
    succeeded(key: string): void;
}

/** The wait after `count` failures in a row, or 0 before the threshold. */
export function backoffMs(count: number): number {
    if (count < FAILURES_BEFORE_BACKOFF) return 0;
    const steps = Math.min(count - FAILURES_BEFORE_BACKOFF, 10);
    return Math.min(FIRST_BACKOFF_MS * 2 ** steps, MAX_BACKOFF_MS);
}

export class MemoryFailureLedger implements FailureLedger {
    private readonly entries = new Map<string, Entry>();

    blocked(key: string, now: Date): boolean {
        const entry = this.entries.get(key);
        return entry !== undefined && entry.until > now.getTime();
    }

    failed(key: string, now: Date): void {
        const count = (this.entries.get(key)?.count ?? 0) + 1;
        this.entries.delete(key);
        if (this.entries.size >= MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(key, {
            count,
            until: now.getTime() + backoffMs(count),
        });
    }

    succeeded(key: string): void {
        this.entries.delete(key);
    }
}

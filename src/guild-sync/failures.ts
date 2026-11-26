/**
 * Remembers ops that keep failing, so one broken object waits out a growing
 * backoff instead of taking a failure slot every cycle. A restart retries
 * everything once, which is what an operator expects after fixing a
 * permission, but keeps each op's failure count (StoredFailureLedger):
 * the count decides when a broken post stops holding back newer ones
 * (postOrder.ts), and a deploy must not reset that.
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
    /** Failures in a row so far; 0 for an op never failed or since forgotten. */
    count(key: string): number;
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

    count(key: string): number {
        return this.entries.get(key)?.count ?? 0;
    }

    /** Takes back a count from before a restart, without a backoff. */
    restore(key: string, count: number): void {
        if (!Number.isInteger(count) || count < 1) return;
        if (this.entries.size >= MAX_ENTRIES) return;
        this.entries.set(key, { count, until: 0 });
    }
}

/** Where failure counts outlive a restart. */
export interface FailureCountStore {
    loadFailureCounts(
        limit: number
    ): Promise<readonly { key: string; count: number }[]>;
    saveFailureCount(key: string, count: number, now: Date): Promise<void>;
    clearFailureCount(key: string): Promise<void>;
}

/**
 * A MemoryFailureLedger whose counts are written through to a store and
 * read back at start. Writes run in the background: a failed write is
 * logged and costs only the count's survival across a restart.
 */
export class StoredFailureLedger implements FailureLedger {
    private readonly memory = new MemoryFailureLedger();

    constructor(
        private readonly store: FailureCountStore,
        private readonly warn: (message: string) => void
    ) {}

    /** Reads the saved counts. A failed read starts empty and says so. */
    async load(): Promise<void> {
        try {
            const rows = await this.store.loadFailureCounts(MAX_ENTRIES);
            for (const row of rows) this.memory.restore(row.key, row.count);
        } catch (error) {
            this.warn(`could not read saved failure counts: ${detail(error)}`);
        }
    }

    blocked(key: string, now: Date): boolean {
        return this.memory.blocked(key, now);
    }

    count(key: string): number {
        return this.memory.count(key);
    }

    failed(key: string, now: Date): void {
        this.memory.failed(key, now);
        const count = this.memory.count(key);
        this.store
            .saveFailureCount(key, count, now)
            .catch((error: unknown) =>
                this.warn(`could not save a failure count: ${detail(error)}`)
            );
    }

    succeeded(key: string): void {
        this.memory.succeeded(key);
        this.store
            .clearFailureCount(key)
            .catch((error: unknown) =>
                this.warn(`could not clear a failure count: ${detail(error)}`)
            );
    }
}

function detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

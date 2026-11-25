/** ID maps change rarely; a copy formatted a few minutes stale is fine. */
export const FIDELITY_TTL_MS = 5 * 60_000;

/**
 * A small cache of loaded values. Entries expire after `ttlMs`; past
 * `maxEntries` the oldest entry goes first, so memory stays bounded.
 */
export class TtlCache<V> {
    private readonly entries = new Map<string, { at: number; value: V }>();

    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries: number,
        private readonly now: () => number
    ) {
        if (ttlMs <= 0 || maxEntries <= 0) {
            throw new RangeError('TtlCache needs a positive TTL and size');
        }
    }

    /** The cached value for `key`, or the loaded one. Load errors propagate. */
    async get(key: string, load: () => Promise<V>): Promise<V> {
        const at = this.now();
        const cached = this.entries.get(key);
        if (cached && at - cached.at < this.ttlMs) return cached.value;
        const value = await load();
        this.entries.delete(key);
        if (this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next();
            if (!oldest.done) this.entries.delete(oldest.value);
        }
        this.entries.set(key, { at, value });
        return value;
    }

    clear(): void {
        this.entries.clear();
    }
}

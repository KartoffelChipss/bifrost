/**
 * Counts events per key over a rolling time window, in memory. A restart
 * clears the counts, which only makes the limits start again.
 */
export class RollingLimit {
    private readonly hits = new Map<string, number[]>();

    /**
     * @param max events allowed per key within `windowMs`
     * @param maxKeys keys tracked at once; the oldest is dropped beyond it
     */
    constructor(
        private readonly max: number,
        private readonly windowMs: number,
        private readonly maxKeys: number
    ) {
        if (!Number.isInteger(max) || max <= 0)
            throw new RangeError('max must be a positive integer');
        if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
        if (!Number.isInteger(maxKeys) || maxKeys <= 0)
            throw new RangeError('maxKeys must be a positive integer');
    }

    /** How many more events `key` may have at `now`. */
    remaining(key: string, now: number): number {
        return this.max - this.recent(key, now).length;
    }

    /** Records up to `count` events for `key`. Returns how many fit. */
    take(key: string, count: number, now: number): number {
        if (!Number.isInteger(count) || count < 0)
            throw new RangeError('count must be a non-negative integer');
        const recent = this.recent(key, now);
        const granted = Math.min(count, this.max - recent.length);
        for (let i = 0; i < granted; i++) recent.push(now);
        this.keep(key, recent);
        return granted;
    }

    private recent(key: string, now: number): number[] {
        const since = now - this.windowMs;
        return (this.hits.get(key) ?? []).filter((at) => at > since);
    }

    private keep(key: string, recent: number[]): void {
        this.hits.delete(key);
        if (recent.length === 0) return;
        if (this.hits.size >= this.maxKeys) {
            const oldest = this.hits.keys().next();
            if (!oldest.done) this.hits.delete(oldest.value);
        }
        this.hits.set(key, recent);
    }
}

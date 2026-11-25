/**
 * Runs work one at a time per key, in the order it was queued. A reaction
 * added and removed in quick succession must reach the other side in that
 * order, or the bot's mirrored reaction would be left behind.
 *
 * A key's entry is dropped once its last task finishes, so the map holds
 * only keys with work in flight.
 */
export class KeyedQueue {
    private readonly tails = new Map<string, Promise<void>>();

    get size(): number {
        return this.tails.size;
    }

    run(key: string, work: () => Promise<void>): Promise<void> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        const next = previous.then(work);
        // The tail never rejects, so a failed task never blocks the next.
        const tail = next.then(
            () => undefined,
            () => undefined
        );
        this.tails.set(key, tail);
        void tail.then(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key);
        });
        return next;
    }
}

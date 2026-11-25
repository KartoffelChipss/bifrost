/**
 * Runs a task again and again: soon after a pass that left work, later
 * after an idle one. Passes never overlap, and stop() waits for the
 * running one.
 */
export class RepeatingTask {
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<void> | null = null;
    private stopped = true;

    constructor(
        private readonly pass: () => Promise<boolean>,
        private readonly busyDelayMs: number,
        private readonly idleDelayMs: number
    ) {
        if (busyDelayMs < 0 || idleDelayMs < busyDelayMs) {
            throw new Error(
                'RepeatingTask needs 0 <= busyDelayMs <= idleDelayMs'
            );
        }
    }

    start(firstDelayMs = 0): void {
        this.stopped = false;
        this.schedule(firstDelayMs);
    }

    private schedule(ms: number): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.running = this.pass()
                .catch(() => false)
                .then((more) => {
                    this.running = null;
                    this.schedule(more ? this.busyDelayMs : this.idleDelayMs);
                });
        }, ms);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        await this.running;
    }
}

import { constants } from 'node:os';
import type { AddonLogger } from './isolation';

/**
 * Stops the add-ons when the process is told to stop, then lets it end the
 * way upstream Bifröst ends: killed by the same signal. Upstream installs
 * no signal handler, so its exit status is 128 + the signal number (143
 * for SIGTERM); exiting with 0 instead would hide that from Docker and
 * process supervisors.
 *
 * Stopping is bounded by the add-on host's shared deadline
 * (DEFAULT_STOP_TIMEOUT_MS in host.ts), inside Docker's 10 s grace period.
 */

export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** Time for the re-raised signal to end the process before exiting. */
export const SIGNAL_EXIT_GRACE_MS = 1_000;

/** The process calls the hook makes; `process` fits it. */
export interface ShutdownProcess {
    readonly pid: number;
    once(signal: ShutdownSignal, listener: () => void): unknown;
    kill(pid: number, signal: ShutdownSignal): unknown;
    exit(code: number): unknown;
}

/** The exit status of a process killed by `signal`. */
export function signalExitCode(signal: ShutdownSignal): number {
    return 128 + constants.signals[signal];
}

export function registerAddonShutdown(
    addons: { stop(): Promise<void> },
    logger: AddonLogger,
    proc: ShutdownProcess = process
): void {
    const shutdown = (signal: ShutdownSignal) => {
        logger.info(`${signal} received, stopping add-ons`);
        addons
            .stop()
            .catch((err) => logger.error('Add-on shutdown error:', err))
            .finally(() => {
                // Our listener is gone (once), so the default action runs.
                proc.kill(proc.pid, signal);
                // If another listener keeps the process alive, exit anyway.
                setTimeout(
                    () => proc.exit(signalExitCode(signal)),
                    SIGNAL_EXIT_GRACE_MS
                ).unref();
            });
    };
    for (const signal of SHUTDOWN_SIGNALS) {
        proc.once(signal, () => shutdown(signal));
    }
}

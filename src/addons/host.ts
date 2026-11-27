import type { AddonConfig } from './config';
import type { AddonLogger, IsolationBoundary } from './isolation';
import type { AddonModeController } from './mode';

/** What every add-on receives at start. */
export interface AddonContext {
    readonly mode: AddonModeController;
    readonly boundary: IsolationBoundary;
    readonly logger: AddonLogger;
    /** True when the environment allows apply mode at all. */
    readonly allowApply: boolean;
}

/** One add-on module: guild-sync, history, identity, archive or name sync. */
export interface Addon {
    readonly name: string;
    start(context: AddonContext): Promise<void>;
    stop(): Promise<void>;
}

export type AddonKey =
    | 'guildSync'
    | 'history'
    | 'identity'
    | 'archive'
    | 'nameSync';
export type AddonFactories = Partial<Record<AddonKey, () => Addon>>;

const ADDON_KEYS: readonly AddonKey[] = [
    'guildSync',
    'history',
    'identity',
    'archive',
    'nameSync',
];
const MAX_ADDONS = ADDON_KEYS.length;
/**
 * One deadline for stopping every add-on together. Docker sends SIGKILL
 * 10 s after SIGTERM, so the add-ons get 8 s and the process has the rest
 * to exit on its own.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 8_000;

/**
 * Picks the add-ons to run from the config. An add-on that is switched on
 * but has no implementation yet is reported in `missing`.
 */
export function selectAddons(
    config: AddonConfig,
    factories: AddonFactories
): { addons: Addon[]; missing: AddonKey[] } {
    const addons: Addon[] = [];
    const missing: AddonKey[] = [];
    for (const key of ADDON_KEYS) {
        if (!config[key]) continue;
        const factory = factories[key];
        if (factory) addons.push(factory());
        else missing.push(key);
    }
    return { addons, missing };
}

export class AddonTimeoutError extends Error {
    constructor(label: string, timeoutMs: number) {
        super(`${label} timed out after ${timeoutMs}ms`);
        this.name = 'AddonTimeoutError';
    }
}

/** Rejects with {@link AddonTimeoutError} when `promise` takes too long. */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new AddonTimeoutError(label, timeoutMs)),
            timeoutMs
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Starts and stops add-ons, each inside the isolation boundary. */
export class AddonHost {
    private readonly started: Addon[] = [];

    constructor(
        private readonly addons: readonly Addon[],
        private readonly context: AddonContext,
        private readonly stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS
    ) {
        if (addons.length > MAX_ADDONS) {
            throw new Error(
                `At most ${MAX_ADDONS} add-ons are supported, got ${addons.length}`
            );
        }
        const names = new Set(addons.map((addon) => addon.name));
        if (names.size !== addons.length) {
            throw new Error('Add-on names must be unique');
        }
        if (stopTimeoutMs <= 0) {
            throw new Error('stopTimeoutMs must be positive');
        }
    }

    /** Starts each add-on. A failed start never stops the others. */
    async startAll(): Promise<{ started: string[]; failed: string[] }> {
        const failed: string[] = [];
        for (const addon of this.addons) {
            const result = await this.context.boundary.run(
                addon.name,
                'start',
                () => addon.start(this.context)
            );
            if (result.ok) this.started.push(addon);
            else failed.push(addon.name);
        }
        return { started: this.started.map((addon) => addon.name), failed };
    }

    /**
     * Stops started add-ons in reverse order, all within one shared
     * deadline of `stopTimeoutMs`. An add-on still stopping at the deadline
     * is left behind; the ones after it are asked to stop but not waited
     * for.
     */
    async stopAll(now: () => number = Date.now): Promise<void> {
        const toStop = this.started.splice(0).reverse();
        const deadline = now() + this.stopTimeoutMs;
        for (const addon of toStop) {
            const left = deadline - now();
            if (left <= 0) {
                this.context.logger.warn(
                    `[addons] Shutdown deadline passed; not waiting for ${addon.name}`
                );
                // Still asked to stop, so its timers and listeners go.
                void this.context.boundary.run(addon.name, 'stop', () =>
                    addon.stop()
                );
                continue;
            }
            await this.context.boundary.run(addon.name, 'stop', () =>
                withTimeout(addon.stop(), left, addon.name)
            );
        }
    }
}

import type { AddonDatabaseState } from './db/migrator';

/**
 * The result of the add-on migrations at startup. Upstream's src/index.ts
 * ignores the return value of initAddonDatabase, so the add-on hooks it
 * calls afterwards (intents, commands, startAddons) read it here: after a
 * failed migration they leave upstream as it is.
 */
let current: AddonDatabaseState | null = null;

export function recordAddonDatabaseState(state: AddonDatabaseState): void {
    current = state;
}

/** Null before initAddonDatabase has run. */
export function addonDatabaseState(): AddonDatabaseState | null {
    return current;
}

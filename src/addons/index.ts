import type { AddonConfig } from './config';
import { AddonHost, selectAddons, type AddonFactories } from './host';
import { IsolationBoundary, type AddonLogger } from './isolation';
import { AddonModeController } from './mode';
import { createGuildSyncAddon, type GuildSyncDeps } from '../guild-sync';

export { requireAddonConfig } from './config';
export { addonDiscordIntents } from './intents';
export { initAddonDatabase } from './db/migrator';

export interface AddonsHandle {
    stop(): Promise<void>;
}

/** What the add-ons need from Bifröst. Built once in src/index.ts. */
export type AddonDeps = GuildSyncDeps;

/** Add-on implementations. Each add-on registers here when it lands. */
export function addonFactories(deps: AddonDeps): AddonFactories {
    return { guildSync: () => createGuildSyncAddon(deps) };
}

/**
 * Starts the enabled add-ons. Returns null when add-ons are off, so the
 * caller leaves Bifröst's behaviour untouched.
 */
export async function startAddons(
    config: AddonConfig,
    logger: AddonLogger,
    factories: AddonFactories
): Promise<AddonsHandle | null> {
    if (!config.enabled) {
        logger.info('[addons] Add-ons are disabled');
        return null;
    }

    const mode = new AddonModeController(config.initialMode);
    const boundary = new IsolationBoundary(mode, logger);
    const { addons, missing } = selectAddons(config, factories);
    for (const key of missing) {
        logger.warn(`[addons] ${key} is enabled but not implemented yet`);
    }

    const host = new AddonHost(addons, {
        mode,
        boundary,
        logger,
        allowApply: config.allowApply,
    });
    const { started, failed } = await host.startAll();
    logger.info(
        `[addons] Mode ${mode.mode}, apply ${config.allowApply ? 'allowed' : 'not allowed'}. Started: ${started.join(', ') || 'none'}. Failed: ${failed.join(', ') || 'none'}.`
    );
    return { stop: () => host.stopAll() };
}

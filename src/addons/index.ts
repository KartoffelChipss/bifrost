import type { Sequelize } from 'sequelize';
import type { AddonConfig } from './config';
import {
    initAddonDatabase as migrateAddonDatabase,
    type AddonDatabaseState,
} from './db/migrator';
import { AddonHost, selectAddons, type AddonFactories } from './host';
import { IsolationBoundary, type AddonLogger } from './isolation';
import { AddonModeController } from './mode';
import { createGuildSyncAddon, type GuildSyncDeps } from '../guild-sync';
import { discordNoticeSender } from '../guild-sync/notifier';
import { FluxerGuildWriter } from '../guild-sync/writers/fluxer';
import { createHistoryAddon } from '../history';
import type { HistoryPorts } from '../history/types';
import { createIdentityAddon, type IdentityPorts } from '../identity';

export { requireAddonConfig } from './config';
export { addonDiscordIntents } from './intents';

/**
 * The result of the last {@link initAddonDatabase} call. Upstream's
 * src/index.ts ignores its return value, so {@link startAddons} reads it
 * here: after a failed migration the add-ons stay off and the relay runs.
 */
let databaseState: AddonDatabaseState | null = null;

/** Prepares the add-on tables and records whether they are ready. */
export async function initAddonDatabase(
    config: AddonConfig,
    sequelize: Sequelize,
    logger: AddonLogger
): Promise<AddonDatabaseState> {
    databaseState = await migrateAddonDatabase(config, sequelize, logger);
    return databaseState;
}

export interface AddonsHandle {
    stop(): Promise<void>;
}

/** What the add-ons need from Bifröst. Built once in src/index.ts. */
export type AddonDeps = Omit<
    GuildSyncDeps,
    'historyEnabled' | 'bridge' | 'excludedChannels'
> & {
    readonly bridge: GuildSyncDeps['bridge'] & HistoryPorts & IdentityPorts;
};

/** Add-on implementations, each built only when it is switched on. */
export function addonFactories(
    deps: AddonDeps,
    config: AddonConfig
): AddonFactories {
    const sendNotice = discordNoticeSender(
        deps.discordClient,
        deps.isChannelLinked
    );
    return {
        guildSync: () =>
            createGuildSyncAddon({
                ...deps,
                historyEnabled: config.history,
                excludedChannels: config.excludedChannels,
            }),
        history: () =>
            createHistoryAddon({
                discordClient: deps.discordClient,
                sequelize: deps.sequelize,
                listGuildLinks: deps.listGuildLinks,
                links: deps.bridge,
                ports: deps.bridge,
                writer: new FluxerGuildWriter(deps.fluxerClientRef),
                sendNotice,
                excludedChannels: config.excludedChannels,
                commandPrefix: deps.commandPrefix,
            }),
        identity: () =>
            createIdentityAddon({
                discordClient: deps.discordClient,
                fluxerClientRef: deps.fluxerClientRef,
                sequelize: deps.sequelize,
                listGuildLinks: deps.listGuildLinks,
                ports: deps.bridge,
                historyEnabled: config.history,
                links: deps.bridge,
                historyPorts: deps.bridge,
                sendNotice,
                commandPrefix: deps.commandPrefix,
            }),
    };
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
        for (const warning of config.warnings)
            logger.warn(`[addons] ${warning}`);
        logger.info('[addons] Add-ons are disabled');
        return null;
    }
    if (databaseState === 'failed') {
        logger.error(
            '[addons] Add-ons are off because their migrations failed. The relay keeps running.'
        );
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

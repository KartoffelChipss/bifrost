import type { AddonConfig } from './config';
import { AddonHost, selectAddons, type AddonFactories } from './host';
import { IsolationBoundary, type AddonLogger } from './isolation';
import { AddonModeController } from './mode';
import { createGuildSyncAddon, type GuildSyncDeps } from '../guild-sync';
import { discordNoticeSender } from '../guild-sync/notifier';
import { FluxerGuildWriter } from '../guild-sync/writers/fluxer';
import { createHistoryAddon } from '../history';
import type { HistoryPorts } from '../history/types';
import { createIdentityAddon, type IdentityPorts } from '../identity';
import { createRelayExtras, withRelayExtras } from '../relay-extras';
import type { RelayLookupPorts } from '../relay-extras/types';

export { requireAddonConfig } from './config';
export { addonDiscordIntents, addonDiscordPartials } from './intents';
export { initAddonDatabase } from './db/migrator';

export interface AddonsHandle {
    stop(): Promise<void>;
}

/** What the add-ons need from Bifröst. Built once in src/index.ts. */
export type AddonDeps = Omit<
    GuildSyncDeps,
    'historyEnabled' | 'bridge' | 'excludedChannels'
> & {
    readonly bridge: GuildSyncDeps['bridge'] &
        HistoryPorts &
        IdentityPorts &
        RelayLookupPorts;
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
        // Live reactions and pins start and stop with guild-sync.
        guildSync: () =>
            withRelayExtras(
                createGuildSyncAddon({
                    ...deps,
                    historyEnabled: config.history,
                    excludedChannels: config.excludedChannels,
                }),
                createRelayExtras({
                    discordClient: deps.discordClient,
                    fluxerClientRef: deps.fluxerClientRef,
                    sequelize: deps.sequelize,
                    lookups: deps.bridge,
                })
            ),
        history: () =>
            createHistoryAddon({
                sequelize: deps.sequelize,
                listGuildLinks: deps.listGuildLinks,
                links: deps.bridge,
                ports: deps.bridge,
                writer: new FluxerGuildWriter(deps.fluxerClientRef),
                sendNotice,
                excludedChannels: config.excludedChannels,
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

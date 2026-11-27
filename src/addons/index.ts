import type { Sequelize } from 'sequelize';
import { DEFAULT_ARCHIVE_MIN_FREE_GB, type AddonConfig } from './config';
import {
    initAddonDatabase as migrateAddonDatabase,
    type AddonDatabaseState,
} from './db/migrator';
import { AddonHost, selectAddons, type AddonFactories } from './host';
import { IsolationBoundary, type AddonLogger } from './isolation';
import { AddonModeController } from './mode';
import { addonDatabaseState, recordAddonDatabaseState } from './state';
import { createArchiveAddon } from '../archive';
import { createGuildSyncAddon, type GuildSyncDeps } from '../guild-sync';
import { discordNoticeSender } from '../guild-sync/notifier';
import { FluxerGuildWriter } from '../guild-sync/writers/fluxer';
import { createHistoryAddon, editorThreads, historyLinkHook } from '../history';
import type { HistoryPorts } from '../history/types';
import { createIdentityAddon, type IdentityPorts } from '../identity';
import { createNameSyncAddon } from '../name-sync';
import { createRelayExtras, withRelayExtras } from '../relay-extras';
import type { RelayLookupPorts } from '../relay-extras/types';

export { requireAddonConfig } from './config';
export { addonDiscordIntents, addonDiscordPartials } from './intents';

/**
 * Prepares the add-on tables and records whether they are ready
 * (state.ts): after a failed migration the add-ons stay off and the relay
 * runs.
 */
export async function initAddonDatabase(
    config: AddonConfig,
    sequelize: Sequelize,
    logger: AddonLogger
): Promise<AddonDatabaseState> {
    const state = await migrateAddonDatabase(config, sequelize, logger);
    recordAddonDatabaseState(state);
    return state;
}

export interface AddonsHandle {
    stop(): Promise<void>;
}

/** What the add-ons need from Bifröst. Built once in src/index.ts. */
export type AddonDeps = Omit<
    GuildSyncDeps,
    'historyEnabled' | 'identityEnabled' | 'bridge' | 'excludedChannels'
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
                    identityEnabled: config.identity,
                    excludedChannels: config.excludedChannels,
                }),
                createRelayExtras({
                    discordClient: deps.discordClient,
                    fluxerClientRef: deps.fluxerClientRef,
                    sequelize: deps.sequelize,
                    lookups: deps.bridge,
                    excludedChannels: config.excludedChannels,
                    listGuildLinks: deps.listGuildLinks,
                    links: deps.bridge,
                })
            ),
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
                inlineMax: config.historyInlineMax ?? 0,
                sendIntervalMs: config.historySendIntervalMs,
                statusSignal: deps.statusSignal,
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
                editorThreads: editorThreads({
                    listGuildLinks: deps.listGuildLinks,
                    ports: deps.bridge,
                    writer: new FluxerGuildWriter(deps.fluxerClientRef),
                }),
                sendNotice,
                commandPrefix: deps.commandPrefix,
                // A new link re-renders imported copies that mention them.
                onAccountLinked: config.history
                    ? historyLinkHook(deps)
                    : undefined,
            }),
        ...(config.archiveDir
            ? {
                  archive: () =>
                      createArchiveAddon({
                          discordClient: deps.discordClient,
                          sequelize: deps.sequelize,
                          listGuildLinks: deps.listGuildLinks,
                          excludedChannels: config.excludedChannels,
                          dir: config.archiveDir ?? '',
                          minFreeBytes:
                              (config.archiveMinFreeGb ??
                                  DEFAULT_ARCHIVE_MIN_FREE_GB) *
                              1024 ** 3,
                      }),
              }
            : {}),
        ...(config.fluxerDb
            ? {
                  nameSync: () =>
                      createNameSyncAddon({
                          discordClient: deps.discordClient,
                          fluxerClientRef: deps.fluxerClientRef,
                          sequelize: deps.sequelize,
                          listGuildLinks: deps.listGuildLinks,
                          fluxerDb: config.fluxerDb as NonNullable<
                              AddonConfig['fluxerDb']
                          >,
                      }),
              }
            : {}),
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
    // Settings that are only warnings while add-ons are on, such as a bad
    // BF_ADDONS_RESET_USER_ID, which leaves its one command off.
    for (const warning of config.warnings) logger.warn(`[addons] ${warning}`);
    if (addonDatabaseState() === 'failed') {
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

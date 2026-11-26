import sequelize from '../db/sequelize';
import { UpstreamBridge } from '../guild-sync/upstreamBridge';
import { COMMAND_PREFIX, DISCORD_OWNER_ID } from '../utils/env';
import logger from '../utils/logging/logger';
import { createForkBootstrap, type ForkBootstrap } from './bootstrap';
import { addonDiscordCommands } from './commands';
import { addonFactories, initAddonDatabase, startAddons } from './index';

/**
 * The fork's entry point for upstream's src/index.ts. It loads upstream's
 * env, database, logger and command classes, so it stays apart from
 * './index', which tests load without Bifröst's environment.
 *
 * Reads the add-on settings and throws on a bad one. Call it first.
 */
export function forkInit(): ForkBootstrap {
    return createForkBootstrap({
        env: process.env,
        sequelize,
        logger,
        commandPrefix: COMMAND_PREFIX,
        discordOwnerId: DISCORD_OWNER_ID,
        runtime: {
            initAddonDatabase,
            addonDiscordCommands,
            createBridge: (services) =>
                new UpstreamBridge({
                    ...services,
                    warn: (detail) => logger.warn(detail),
                }),
            addonFactories,
            startAddons,
        },
        processHooks: process,
    });
}

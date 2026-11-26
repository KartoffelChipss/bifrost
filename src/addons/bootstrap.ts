import type { Sequelize } from 'sequelize';
import type { GatewayIntentBits, Partials } from 'discord.js';
import { StatusSignal } from '../guild-sync/statusSignal';
import type { UpstreamServices } from '../guild-sync/upstreamBridge';
import type { LinkService } from '../services/LinkService';
import type { AddonCommandDeps, DiscordCommandFactory } from './commands';
import { requireAddonConfig, type AddonConfig } from './config';
import type { AddonFactories } from './host';
import type { AddonDeps, AddonsHandle } from './index';
import { addonDiscordIntents, addonDiscordPartials } from './intents';
import { registerAddonShutdown, type ShutdownProcess } from './shutdown';
import type { AddonLogger } from './isolation';

/**
 * Everything the fork adds to upstream's src/index.ts, behind four calls.
 * Upstream's file only creates the bootstrap, runs its database step, hands
 * its Discord extension to startDiscordClient and starts it once both
 * clients run. src/addons/fork.ts wires the real dependencies; this file
 * takes them as arguments so it stays testable without Bifröst's env.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The link lookups the add-ons read from upstream's LinkService. */
export type AddonLinkService = Pick<
    LinkService,
    | 'getAllGuildLinks'
    | 'getGuildLinkForDiscordGuild'
    | 'getChannelLinkByDiscordChannelId'
>;

/** What the enabled add-ons add to upstream's Discord client. */
export interface DiscordClientExtension {
    readonly intents: GatewayIntentBits[];
    readonly partials: Partials[];
    readonly commands: Readonly<Record<string, DiscordCommandFactory>>;
}

/** The add-on functions the bootstrap calls. Tests replace them. */
export interface AddonRuntime {
    initAddonDatabase(
        config: AddonConfig,
        sequelize: Sequelize,
        logger: AddonLogger
    ): Promise<unknown>;
    addonDiscordCommands(
        config: AddonConfig,
        deps: AddonCommandDeps
    ): Readonly<Record<string, DiscordCommandFactory>>;
    createBridge(services: UpstreamServices): AddonDeps['bridge'];
    addonFactories(deps: AddonDeps, config: AddonConfig): AddonFactories;
    startAddons(
        config: AddonConfig,
        logger: AddonLogger,
        factories: AddonFactories
    ): Promise<AddonsHandle | null>;
}

/** The process calls the shutdown handler needs. */
/** The process calls shutdown makes (see shutdown.ts); `process` fits. */
export type ProcessHooks = ShutdownProcess;

export interface ForkBootstrapDeps {
    readonly env: Env;
    readonly sequelize: Sequelize;
    readonly logger: AddonLogger;
    readonly commandPrefix: string;
    readonly discordOwnerId: string | null;
    readonly runtime: AddonRuntime;
    readonly processHooks: ProcessHooks;
}

export interface ForkBootstrap {
    readonly config: AddonConfig;
    /** Prepares the add-on tables. A failed migration keeps add-ons off. */
    initDatabase(): Promise<void>;
    /** The intents, partials and commands for startDiscordClient. */
    discordExtension(linkService: AddonLinkService): DiscordClientExtension;
    /** Starts the add-ons and stops them on SIGTERM or SIGINT. */
    start(services: UpstreamServices): Promise<void>;
}

/** True when the Discord channel is part of a channel link. */
function channelLinkCheck(
    linkService: AddonLinkService
): (discordChannelId: string) => Promise<boolean> {
    return async (id) =>
        (await linkService.getChannelLinkByDiscordChannelId(id)) !== null;
}

function buildDiscordExtension(
    deps: ForkBootstrapDeps,
    config: AddonConfig,
    linkService: AddonLinkService,
    statusSignal: StatusSignal
): DiscordClientExtension {
    return {
        intents: addonDiscordIntents(config),
        partials: addonDiscordPartials(config),
        commands: deps.runtime.addonDiscordCommands(config, {
            sequelize: deps.sequelize,
            findGuildLink: (id) => linkService.getGuildLinkForDiscordGuild(id),
            discordOwnerId: deps.discordOwnerId,
            isChannelLinked: channelLinkCheck(linkService),
            statusSignal,
        }),
    };
}

async function startForkAddons(
    deps: ForkBootstrapDeps,
    config: AddonConfig,
    services: UpstreamServices,
    statusSignal: StatusSignal
): Promise<void> {
    const { runtime, logger } = deps;
    const addons = await runtime.startAddons(
        config,
        logger,
        runtime.addonFactories(
            {
                discordClient: services.discordClient,
                fluxerClientRef: services.fluxerClientRef,
                listGuildLinks: () => services.linkService.getAllGuildLinks(),
                isChannelLinked: channelLinkCheck(services.linkService),
                commandPrefix: deps.commandPrefix,
                sequelize: deps.sequelize,
                bridge: runtime.createBridge(services),
                statusSignal,
            },
            config
        )
    );
    if (addons) registerAddonShutdown(addons, logger, deps.processHooks);
}

/**
 * Reads the add-on settings. Throws on a bad setting, so call it before
 * anything else runs: startup then fails exactly as it did before.
 */
export function createForkBootstrap(deps: ForkBootstrapDeps): ForkBootstrap {
    const config = requireAddonConfig(deps.env);
    // Shared by the `sync` command and the add-ons, which start later.
    const statusSignal = new StatusSignal();
    return {
        config,
        initDatabase: async () => {
            await deps.runtime.initAddonDatabase(
                config,
                deps.sequelize,
                deps.logger
            );
        },
        discordExtension: (linkService) =>
            buildDiscordExtension(deps, config, linkService, statusSignal),
        start: (services) =>
            startForkAddons(deps, config, services, statusSignal),
    };
}

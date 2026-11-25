import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayIntentBits, Partials } from 'discord.js';
import type { Sequelize } from 'sequelize';
import {
    createForkBootstrap,
    type AddonLinkService,
    type AddonRuntime,
    type ForkBootstrapDeps,
    type ProcessHooks,
} from '../../src/addons/bootstrap';
import type { DiscordCommandFactory } from '../../src/addons/commands';
import type { AddonDeps } from '../../src/addons/index';
import type { UpstreamServices } from '../../src/guild-sync/upstreamBridge';
import { createRecordingLogger } from './fakes';

const GUILD_SYNC_ON = {
    BF_ADDONS_ENABLED: 'true',
    BF_DB_DIALECT: 'postgres',
    BF_ADDON_GUILD_SYNC: 'true',
};

const fakeSequelize = { name: 'sequelize' } as unknown as Sequelize;

const linkService: AddonLinkService = {
    getAllGuildLinks: async () => [],
    getGuildLinkForDiscordGuild: async () => null,
    getChannelLinkByDiscordChannelId: async (id: string) =>
        (id === 'linked' ? {} : null) as Awaited<
            ReturnType<AddonLinkService['getChannelLinkByDiscordChannelId']>
        >,
};

const services = {
    discordClient: { name: 'discord' },
    fluxerClientRef: { current: null },
    linkService,
    webhookService: {},
    discordEntityResolver: {},
    fluxerEntityResolver: {},
} as unknown as UpstreamServices;

interface Harness {
    deps: ForkBootstrapDeps;
    calls: string[];
    signals: Map<string, () => void>;
    exits: number[];
    kills: string[];
    factoryDeps: AddonDeps[];
    logger: ReturnType<typeof createRecordingLogger>;
}

function fakeRuntime(
    calls: string[],
    factoryDeps: AddonDeps[],
    stop: () => Promise<void>,
    started: boolean
): AddonRuntime {
    return {
        initAddonDatabase: async (config, sequelize) => {
            assert.equal(sequelize, fakeSequelize);
            calls.push(`db:${config.enabled}`);
            return config.enabled ? 'ready' : 'off';
        },
        addonDiscordCommands: (
            config,
            deps
        ): Record<string, DiscordCommandFactory> => {
            calls.push('commands');
            if (!config.guildSync) return {};
            return { sync: (): never => deps as never };
        },
        createBridge: (upstream) => {
            assert.equal(upstream, services);
            calls.push('bridge');
            return { bridge: true } as unknown as AddonDeps['bridge'];
        },
        addonFactories: (deps) => {
            calls.push('factories');
            factoryDeps.push(deps);
            return {};
        },
        startAddons: async () => {
            calls.push('start');
            return started ? { stop } : null;
        },
    };
}

function harness(
    env: Record<string, string>,
    options: { stop?: () => Promise<void>; started?: boolean } = {}
): Harness {
    const calls: string[] = [];
    const signals = new Map<string, () => void>();
    const exits: number[] = [];
    const kills: string[] = [];
    const factoryDeps: AddonDeps[] = [];
    const logger = createRecordingLogger();
    const processHooks: ProcessHooks = {
        pid: 42,
        once: (signal, listener) => void signals.set(signal, listener),
        kill: (_pid, signal) => void kills.push(signal),
        exit: (code) => void exits.push(code),
    };
    const stop = options.stop ?? (async () => void calls.push('stop'));
    return {
        calls,
        signals,
        exits,
        kills,
        factoryDeps,
        logger,
        deps: {
            env,
            sequelize: fakeSequelize,
            logger,
            commandPrefix: '!b ',
            discordOwnerId: 'owner',
            runtime: fakeRuntime(
                calls,
                factoryDeps,
                stop,
                options.started ?? false
            ),
            processHooks,
        },
    };
}

/** Lets the shutdown promise chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('createForkBootstrap', () => {
    it('throws on a bad add-on setting before anything runs', () => {
        const h = harness({ BF_ADDONS_ENABLED: 'maybe' });
        assert.throws(() => createForkBootstrap(h.deps));
        assert.deepEqual(h.calls, []);
    });

    it('adds nothing to the Discord client when add-ons are off', async () => {
        const h = harness({});
        const fork = createForkBootstrap(h.deps);
        await fork.initDatabase();
        const extension = fork.discordExtension(linkService);
        assert.deepEqual(extension, {
            intents: [],
            partials: [],
            commands: {},
        });
        assert.deepEqual(h.calls, ['db:false', 'commands']);
    });

    it('adds guild-sync intents, partials and the sync command', () => {
        const fork = createForkBootstrap(harness(GUILD_SYNC_ON).deps);
        const extension = fork.discordExtension(linkService);
        assert.ok(
            extension.intents.includes(GatewayIntentBits.GuildMessageReactions)
        );
        assert.deepEqual(extension.partials, [
            Partials.Reaction,
            Partials.User,
        ]);
        assert.deepEqual(Object.keys(extension.commands), ['sync']);
    });

    it('passes link lookups and settings to the command factory', async () => {
        const fork = createForkBootstrap(harness(GUILD_SYNC_ON).deps);
        const { commands } = fork.discordExtension(linkService);
        const deps = commands.sync(services.discordClient) as unknown as {
            discordOwnerId: string;
            isChannelLinked: (id: string) => Promise<boolean>;
        };
        assert.equal(deps.discordOwnerId, 'owner');
        assert.equal(await deps.isChannelLinked('linked'), true);
        assert.equal(await deps.isChannelLinked('other'), false);
    });
});

describe('ForkBootstrap.start', () => {
    it('builds the bridge, then the factories, then starts', async () => {
        const h = harness(GUILD_SYNC_ON, { started: true });
        await createForkBootstrap(h.deps).start(services);
        assert.deepEqual(h.calls, ['bridge', 'factories', 'start']);
        const [deps] = h.factoryDeps;
        assert.equal(deps.discordClient, services.discordClient);
        assert.equal(deps.fluxerClientRef, services.fluxerClientRef);
        assert.equal(deps.commandPrefix, '!b ');
        assert.equal(deps.sequelize, fakeSequelize);
        assert.equal(await deps.isChannelLinked('linked'), true);
    });

    it('registers no signal handlers when no add-ons started', async () => {
        const h = harness({}, { started: false });
        await createForkBootstrap(h.deps).start(services);
        assert.equal(h.signals.size, 0);
    });

    it('stops the add-ons, then ends by the same signal', async () => {
        const h = harness(GUILD_SYNC_ON, { started: true });
        await createForkBootstrap(h.deps).start(services);
        assert.deepEqual([...h.signals.keys()], ['SIGTERM', 'SIGINT']);
        h.signals.get('SIGTERM')?.();
        await settle();
        assert.deepEqual(h.calls.slice(-1), ['stop']);
        assert.deepEqual(h.kills, ['SIGTERM']);
        assert.ok(
            h.logger.entries.some(
                (e) => e.message === 'SIGTERM received, stopping add-ons'
            )
        );
    });

    it('logs a failed stop and still ends', async () => {
        const failure = new Error('stop failed');
        const h = harness(GUILD_SYNC_ON, {
            started: true,
            stop: async () => {
                throw failure;
            },
        });
        await createForkBootstrap(h.deps).start(services);
        h.signals.get('SIGINT')?.();
        await settle();
        assert.deepEqual(h.kills, ['SIGINT']);
        const logged = h.logger.entries.find((e) => e.level === 'error');
        assert.equal(logged?.message, 'Add-on shutdown error:');
        assert.deepEqual(logged?.meta, [failure]);
    });

    it('lets a start failure reach the caller', async () => {
        const h = harness(GUILD_SYNC_ON);
        h.deps.runtime.startAddons = async () => {
            throw new Error('boom');
        };
        await assert.rejects(createForkBootstrap(h.deps).start(services), {
            message: 'boom',
        });
        assert.equal(h.signals.size, 0);
    });
});

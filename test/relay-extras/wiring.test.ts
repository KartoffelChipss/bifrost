import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { Events, GatewayIntentBits, Partials } from 'discord.js';
import type { Client as DiscordClient } from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { AddonConfig } from '../../src/addons/config';
import type { Addon, AddonContext } from '../../src/addons/host';
import {
    addonDiscordIntents,
    addonDiscordPartials,
} from '../../src/addons/intents';
import { IsolationBoundary } from '../../src/addons/isolation';
import { AddonModeController } from '../../src/addons/mode';
import {
    createRelayExtras,
    withRelayExtras,
    type RelayExtras,
} from '../../src/relay-extras';
import { createRecordingLogger } from '../addons/fakes';

const OFF: AddonConfig = {
    enabled: true,
    guildSync: false,
    history: false,
    identity: false,
    initialMode: 'dry-run',
    allowApply: false,
    excludedChannels: new Set(),
    warnings: [],
};

describe('add-on intents and partials for live reactions', () => {
    it('asks for reactions and their partials only with guild-sync', () => {
        assert.ok(
            !addonDiscordIntents(OFF).includes(
                GatewayIntentBits.GuildMessageReactions
            )
        );
        assert.deepEqual(addonDiscordPartials(OFF), []);
        const on = { ...OFF, guildSync: true };
        assert.ok(
            addonDiscordIntents(on).includes(
                GatewayIntentBits.GuildMessageReactions
            )
        );
        assert.deepEqual(addonDiscordPartials(on), [
            Partials.Reaction,
            Partials.User,
        ]);
    });
});

function context(): AddonContext {
    const mode = new AddonModeController('dry-run');
    const logger = createRecordingLogger();
    return {
        mode,
        boundary: new IsolationBoundary(mode, logger),
        logger,
        allowApply: false,
    };
}

function recorder(log: string[], name: string, failStart = false) {
    return {
        name,
        async start() {
            log.push(`${name} start`);
            if (failStart) throw new Error(`${name} failed`);
        },
        async stop() {
            log.push(`${name} stop`);
        },
    };
}

describe('withRelayExtras', () => {
    it('starts after and stops before the add-on it rides on', async () => {
        const log: string[] = [];
        const addon = withRelayExtras(
            recorder(log, 'guild-sync'),
            recorder(log, 'extras')
        );
        assert.equal(addon.name, 'guild-sync');
        await addon.start(context());
        await addon.stop();
        assert.deepEqual(log, [
            'guild-sync start',
            'extras start',
            'extras stop',
            'guild-sync stop',
        ]);
    });

    it('stops the add-on again when the extras fail to start', async () => {
        const log: string[] = [];
        const addon = withRelayExtras(
            recorder(log, 'guild-sync'),
            recorder(log, 'extras', true)
        );
        await assert.rejects(addon.start(context()), /extras failed/);
        assert.deepEqual(log, [
            'guild-sync start',
            'extras start',
            'guild-sync stop',
        ]);
    });

    it('stops the add-on even when stopping the extras fails', async () => {
        const log: string[] = [];
        const extras: RelayExtras = {
            start: async () => undefined,
            stop: async () => {
                throw new Error('stuck');
            },
        };
        const inner: Addon = recorder(log, 'guild-sync');
        const addon = withRelayExtras(inner, extras);
        await addon.start(context());
        await assert.rejects(addon.stop(), /stuck/);
        assert.deepEqual(log, ['guild-sync start', 'guild-sync stop']);
    });
});

describe('createRelayExtras', () => {
    it('listens on Discord while started and detaches on stop', async () => {
        const discord = new EventEmitter();
        const extras = createRelayExtras({
            discordClient: discord as unknown as DiscordClient,
            fluxerClientRef: { current: null },
            sequelize: { getDialect: () => 'postgres' } as Sequelize,
            lookups: {
                bridgedMessage: async () => null,
                guildEmoji: async () => null,
            },
            listGuildLinks: async () => [],
            links: {
                byDiscordChannel: async () => null,
                byFluxerChannel: async () => null,
            },
        });
        await extras.start(context());
        for (const event of [
            Events.MessageReactionAdd,
            Events.MessageReactionRemove,
            Events.MessageReactionRemoveEmoji,
            Events.MessageUpdate,
        ]) {
            assert.equal(discord.listenerCount(event), 1, event);
        }
        await extras.stop();
        assert.equal(discord.eventNames().length, 0);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayIntentBits } from 'discord.js';
import type { AddonConfig } from '../../src/addons/config';
import {
    addonDiscordIntents,
    addonDiscordPartials,
    upstreamCommandAllowed,
} from '../../src/addons/intents';

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

describe('addonDiscordIntents', () => {
    it('adds no intents when every add-on is off', () => {
        assert.deepEqual(addonDiscordIntents(OFF), []);
    });

    it('never asks for the privileged Guild Members intent without identity', () => {
        const intents = addonDiscordIntents({
            ...OFF,
            guildSync: true,
            history: true,
        });
        assert.ok(!intents.includes(GatewayIntentBits.GuildMembers));
        assert.ok(intents.includes(GatewayIntentBits.GuildExpressions));
    });

    it('asks for Guild Members and Direct Messages with identity', () => {
        const intents = addonDiscordIntents({ ...OFF, identity: true });
        assert.ok(intents.includes(GatewayIntentBits.GuildMembers));
        assert.ok(intents.includes(GatewayIntentBits.DirectMessages));
        assert.ok(intents.includes(GatewayIntentBits.GuildModeration));
    });
});

describe('upstreamCommandAllowed', () => {
    it('keeps upstream commands out of DMs once add-ons ask for DMs', () => {
        const identity = addonDiscordIntents({ ...OFF, identity: true });
        assert.equal(upstreamCommandAllowed(false, identity), false);
        assert.equal(upstreamCommandAllowed(true, identity), true);
    });

    it('leaves upstream unchanged when add-ons ask for no DMs', () => {
        assert.equal(upstreamCommandAllowed(false, []), true);
        assert.equal(upstreamCommandAllowed(true, []), true);
    });
});

describe('after failed add-on migrations', () => {
    it('asks for no extra intents or partials', () => {
        const all = { ...OFF, guildSync: true, history: true, identity: true };
        assert.deepEqual(addonDiscordIntents(all, 'failed'), []);
        assert.deepEqual(addonDiscordPartials(all, 'failed'), []);
        assert.ok(addonDiscordIntents(all, 'ready').length > 0);
    });
});

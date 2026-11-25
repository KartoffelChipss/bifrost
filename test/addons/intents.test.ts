import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayIntentBits } from 'discord.js';
import type { AddonConfig } from '../../src/addons/config';
import { addonDiscordIntents } from '../../src/addons/intents';

const OFF: AddonConfig = {
    enabled: true,
    guildSync: false,
    history: false,
    identity: false,
    initialMode: 'dry-run',
    allowApply: false,
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
    });
});

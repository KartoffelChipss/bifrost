import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { Client } from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { AddonConfig } from '../../src/addons/config';

// Upstream's command base class loads src/utils/env.ts, which exits the
// process without tokens. Dummy values let the module load in a test.
process.env.BF_FLUXER_TOKEN ||= 'test-token';
process.env.BF_DISCORD_TOKEN ||= 'test-token';

type CommandsModule = typeof import('../../src/addons/commands');
let commands: CommandsModule;

const CONFIG: AddonConfig = {
    enabled: true,
    guildSync: true,
    history: false,
    identity: false,
    initialMode: 'dry-run',
    allowApply: false,
    excludedChannels: new Set(),
    warnings: [],
};

const DEPS = {
    sequelize: { getDialect: () => 'postgres' } as Sequelize,
    findGuildLink: async () => null,
    discordOwnerId: null,
    isChannelLinked: async () => false,
};

describe('addonDiscordCommands', () => {
    before(async () => {
        commands = await import('../../src/addons/commands');
    });

    it('answers sync with "add-ons are off" after failed migrations', async () => {
        const list = commands.addonDiscordCommands(CONFIG, DEPS, 'failed');
        const handler = list.sync?.({} as Client);
        assert.ok(handler instanceof commands.AddonsOffCommandHandler);
        const replies: unknown[] = [];
        const message = {
            reply: async (options: unknown) => replies.push(options),
            author: { username: 'owner', displayAvatarURL: () => '' },
            content: '!b sync',
        };
        await handler.handleCommand(message as never);
        const embed = (replies[0] as { embeds: { data: object }[] }).embeds[0];
        assert.match(
            (embed.data as { description: string }).description,
            /migrations failed/
        );
    });

    it('registers the real sync command when the tables are ready', () => {
        const list = commands.addonDiscordCommands(CONFIG, DEPS, 'ready');
        const handler = list.sync?.({} as Client);
        assert.ok(handler);
        assert.ok(!(handler instanceof commands.AddonsOffCommandHandler));
    });

    it('adds nothing without guild-sync', () => {
        const off = { ...CONFIG, guildSync: false };
        assert.deepEqual(commands.addonDiscordCommands(off, DEPS, 'ready'), {});
    });
});

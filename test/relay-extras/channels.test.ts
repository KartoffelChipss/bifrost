import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
    Channel as FluxerChannel,
    Client as FluxerClient,
    type ClientOptions,
} from '@fluxerjs/core';
import { ChannelType, Client as DiscordClient } from 'discord.js';
import {
    isRelayedDiscordChannel,
    isRelayedFluxerChannel,
    type DiscordChannelKinds,
} from '../../src/relay-extras/channels';

/** discord.js builds the real channel class from a payload; no login. */
interface DiscordInternals {
    guilds: { _add(data: object): unknown };
    channels: {
        _add(data: object, guild: unknown, o: object): DiscordChannelKinds;
    };
}

const discord = new DiscordClient({ intents: [] });
after(() => discord.destroy());
const internals = discord as unknown as DiscordInternals;
const guild = internals.guilds._add({
    id: '1',
    name: 'guild',
    channels: [],
    roles: [],
    emojis: [],
});

function discordChannel(type: ChannelType): DiscordChannelKinds {
    return internals.channels._add(
        { id: `${100 + type}`, type, guild_id: '1', name: 'c', parent_id: '5' },
        guild,
        { cache: false }
    );
}

const fluxer = new FluxerClient({ intents: 0 } as ClientOptions);

function fluxerChannel(type: number): unknown {
    return FluxerChannel.from(fluxer, {
        id: `${200 + type}`,
        type,
        guild_id: '1',
        name: 'c',
        parent_id: '5',
    } as unknown as Parameters<typeof FluxerChannel.from>[1]);
}

describe('isRelayedDiscordChannel', () => {
    it('accepts text, announcement, voice and stage channels', () => {
        for (const type of [
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildVoice,
            ChannelType.GuildStageVoice,
        ]) {
            assert.equal(isRelayedDiscordChannel(discordChannel(type)), true);
        }
    });

    it('skips threads, which the thread relay handles', () => {
        for (const type of [
            ChannelType.PublicThread,
            ChannelType.AnnouncementThread,
        ]) {
            assert.equal(isRelayedDiscordChannel(discordChannel(type)), false);
        }
    });

    it('skips forums and DMs', () => {
        const forum = discordChannel(ChannelType.GuildForum);
        assert.equal(isRelayedDiscordChannel(forum), false);
        const dm: DiscordChannelKinds = {
            isTextBased: () => true,
            isDMBased: () => true,
            isThread: () => false,
        };
        assert.equal(isRelayedDiscordChannel(dm), false);
    });
});

describe('isRelayedFluxerChannel', () => {
    it('accepts text, announcement and voice channels', () => {
        for (const type of [0, 2, 5]) {
            assert.equal(isRelayedFluxerChannel(fluxerChannel(type)), true);
        }
    });

    it('skips threads, forums and missing channels', () => {
        assert.equal(isRelayedFluxerChannel(fluxerChannel(11)), false);
        assert.equal(isRelayedFluxerChannel(fluxerChannel(15)), false);
        assert.equal(isRelayedFluxerChannel(null), false);
    });
});

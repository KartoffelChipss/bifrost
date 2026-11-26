import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ChannelFlagsBitField,
    ChannelType,
    type ThreadEditOptions,
} from 'discord.js';
import type { LinkedChannel } from '../../src/guild-sync/links';
import type { FluxerThreadInfo } from '../../src/guild-sync/threadMirror';
import {
    UpstreamBridge,
    type UpstreamServices,
} from '../../src/guild-sync/upstreamBridge';

const LINK: LinkedChannel = {
    id: 'cl',
    guildLinkId: 'gl',
    discordChannelId: 'dc',
    fluxerChannelId: 'fc',
    discordWebhook: { id: 'dw', token: 'dw-token' },
    fluxerWebhook: { id: 'fw', token: 'fw-token' },
};

const INFO: FluxerThreadInfo = {
    id: 'f-thread',
    parentId: 'fc',
    name: 'Pinned and locked',
    ownerId: 'fluxer-user',
    forum: false,
    tags: [],
    archived: false,
    locked: true,
    pinned: true,
    rateLimitPerUser: 30,
    autoArchiveDuration: 4320,
};

interface ThreadState {
    readonly locked: boolean;
    readonly rateLimitPerUser: number;
    readonly autoArchiveDuration: number;
    readonly flags: number;
}

/** A new Discord thread whose edits apply, except as `refuse` says. */
function fakeThread(
    state: ThreadState,
    refuse: (changes: ThreadEditOptions) => boolean,
    edits: string[][]
): object {
    return {
        ...state,
        id: 'd-thread',
        parentId: 'dc',
        name: INFO.name,
        archived: false,
        appliedTags: [],
        type: ChannelType.PublicThread,
        ownerId: 'discord-bot',
        flags: new ChannelFlagsBitField(state.flags),
        isThread: () => true,
        async edit(changes: ThreadEditOptions) {
            edits.push(Object.keys(changes));
            if (refuse(changes)) throw new Error('refused by Discord');
            const flags = Number(changes.flags ?? state.flags);
            return fakeThread({ ...state, ...changes, flags }, refuse, edits);
        },
    };
}

function bridgeWith(refuse: (changes: ThreadEditOptions) => boolean) {
    const edits: string[][] = [];
    const fresh = {
        locked: false,
        rateLimitPerUser: 0,
        autoArchiveDuration: 1440,
        flags: 0,
    };
    const parent = {
        type: ChannelType.GuildText,
        threads: { create: async () => fakeThread(fresh, refuse, edits) },
    };
    const services = {
        discordClient: {
            channels: {
                fetch: async (id: string) => (id === 'dc' ? parent : null),
            },
        },
    } as unknown as UpstreamServices;
    return { bridge: new UpstreamBridge(services), edits };
}

describe('a new Discord thread given the Fluxer thread’s settings', () => {
    it('keeps lock and slowmode when Discord refuses the pin', async () => {
        const s = bridgeWith((changes) => changes.flags !== undefined);
        const copy = await s.bridge.createDiscordThread(LINK, INFO);
        assert.ok(copy);
        assert.equal(copy.look.locked, true);
        assert.equal(copy.look.rateLimitPerUser, 30);
        assert.equal(copy.look.autoArchiveDuration, 4320);
        // The look is what the copy has, so the pin shows as drift.
        assert.equal(copy.look.pinned, false);
        assert.equal(copy.refused?.length, 1);
        assert.match(copy.refused?.[0] ?? '', /^flags \(refused by Discord\)$/);
        assert.deepEqual(s.edits, [
            ['locked', 'rateLimitPerUser', 'autoArchiveDuration'],
            ['flags'],
        ]);
    });

    it('takes every setting when Discord allows them', async () => {
        const s = bridgeWith(() => false);
        const copy = await s.bridge.createDiscordThread(LINK, INFO);
        assert.ok(copy);
        assert.equal(copy.look.locked, true);
        assert.equal(copy.look.pinned, true);
        assert.equal(copy.refused, undefined);
    });

    it('keeps the pin when Discord refuses the other settings', async () => {
        const s = bridgeWith((changes) => changes.locked !== undefined);
        const copy = await s.bridge.createDiscordThread(LINK, INFO);
        assert.ok(copy);
        assert.equal(copy.look.locked, false);
        assert.equal(copy.look.rateLimitPerUser, 0);
        assert.equal(copy.look.pinned, true);
        assert.equal(copy.refused?.length, 1);
    });
});

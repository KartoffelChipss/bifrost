import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client as FluxerClient } from '@fluxerjs/core';
import type { Client as DiscordClient } from 'discord.js';
import {
    ClientPlatform,
    discordEmojiPath,
    fluxerEmojiPath,
    othersIn,
    parseFluxerMessage,
} from '../../src/relay-extras/platform';
import { THUMBS } from './fakes';

const PARTY = { id: '42', name: 'party', animated: true };
const D = { channelId: 'dc', messageId: 'dm' };
const F = { channelId: 'fc', messageId: 'fm' };

describe('emoji paths', () => {
    it('encodes unicode for Discord and leaves Fluxer to its route', () => {
        assert.equal(discordEmojiPath(THUMBS), encodeURIComponent('👍'));
        assert.equal(fluxerEmojiPath(THUMBS), '👍');
    });

    it('writes custom emojis as [a:]name:id', () => {
        assert.equal(discordEmojiPath(PARTY), 'a:party:42');
        assert.equal(
            fluxerEmojiPath({ ...PARTY, animated: false }),
            'party:42'
        );
    });
});

describe('parseFluxerMessage', () => {
    it('reads pinned and well-formed reactions', () => {
        const parsed = parseFluxerMessage({
            pinned: true,
            reactions: [
                { emoji: { id: null, name: '👍' }, count: 2, me: true },
                { emoji: { id: '42', name: 'party' }, count: 1 },
                { emoji: { name: 'bad' }, count: 'x' },
                null,
            ],
        });
        assert.deepEqual(parsed, {
            pinned: true,
            reactions: [
                { emoji: { id: null, name: '👍' }, count: 2, me: true },
                { emoji: { id: '42', name: 'party' }, count: 1, me: false },
            ],
        });
    });

    it('rejects a payload without a pinned flag', () => {
        assert.throws(() => parseFluxerMessage({}), /pinned/);
        assert.throws(() => parseFluxerMessage(null), /pinned/);
    });
});

describe('othersIn', () => {
    const reactions = [
        { emoji: { id: null, name: '👍' }, count: 3, me: true },
        { emoji: { id: '42', name: 'renamed' }, count: 1, me: true },
    ];

    it("counts users except the bot's own reaction", () => {
        assert.equal(othersIn(reactions, THUMBS), 2);
        assert.equal(othersIn(reactions, PARTY), 0);
    });

    it('returns 0 for an emoji nobody uses', () => {
        assert.equal(othersIn(reactions, { ...THUMBS, name: '🎉' }), 0);
    });
});

function fakeClients() {
    const calls: string[] = [];
    const discordMessage = {
        pinned: true,
        reactions: {
            cache: new Map([
                [
                    '42',
                    { emoji: { id: '42', name: 'party' }, count: 2, me: true },
                ],
            ]),
        },
    };
    const messages = {
        fetch: async (o: { message: string; force: boolean }) => {
            calls.push(`discord fetch ${o.message} force=${o.force}`);
            return discordMessage;
        },
        pin: async (id: string) => void calls.push(`discord pin ${id}`),
        unpin: async (id: string) => void calls.push(`discord unpin ${id}`),
    };
    const discord = {
        rest: {
            put: async (r: string) => void calls.push(`discord PUT ${r}`),
            delete: async (r: string) => void calls.push(`discord DELETE ${r}`),
        },
        channels: {
            fetch: async () => ({
                isTextBased: () => true,
                isDMBased: () => false,
                messages,
            }),
        },
    } as unknown as DiscordClient;
    const fluxer = {
        isReady: () => true,
        rest: {
            get: async (r: string) => {
                calls.push(`fluxer GET ${r}`);
                return { pinned: false, reactions: [] };
            },
            put: async (r: string) => void calls.push(`fluxer PUT ${r}`),
            delete: async (r: string) => void calls.push(`fluxer DELETE ${r}`),
        },
    } as unknown as FluxerClient;
    return { calls, discord, fluxer };
}

describe('ClientPlatform', () => {
    it("reacts and removes the bot's own reaction on both sides", async () => {
        const { calls, discord, fluxer } = fakeClients();
        const platform = new ClientPlatform(discord, { current: fluxer });
        await platform.react('discord', D, PARTY);
        await platform.unreact('fluxer', F, THUMBS);
        // discord-api-types Routes percent-encodes the colons, as it does
        // for discord.js MessageManager.react.
        assert.deepEqual(calls, [
            'discord PUT /channels/dc/messages/dm/reactions/a%3Aparty%3A42/@me',
            `fluxer DELETE /channels/fc/messages/fm/reactions/${encodeURIComponent('👍')}/@me`,
        ]);
    });

    it('reads a fresh message to count other users', async () => {
        const { calls, discord, fluxer } = fakeClients();
        const platform = new ClientPlatform(discord, { current: fluxer });
        assert.equal(await platform.othersReacting('discord', D, PARTY), 1);
        assert.equal(await platform.othersReacting('fluxer', F, THUMBS), 0);
        assert.deepEqual(calls, [
            'discord fetch dm force=true',
            'fluxer GET /channels/fc/messages/fm',
        ]);
    });

    it('reads and sets pins on both sides', async () => {
        const { calls, discord, fluxer } = fakeClients();
        const platform = new ClientPlatform(discord, { current: fluxer });
        assert.equal(await platform.pinned('discord', D), true);
        assert.equal(await platform.pinned('fluxer', F), false);
        await platform.setPinned('discord', D, false);
        await platform.setPinned('fluxer', F, true);
        await platform.setPinned('fluxer', F, false);
        assert.deepEqual(calls.slice(2), [
            'discord unpin dm',
            'fluxer PUT /channels/fc/pins/fm',
            'fluxer DELETE /channels/fc/pins/fm',
        ]);
    });

    it('fails when the Fluxer gateway is not connected', async () => {
        const { discord } = fakeClients();
        const platform = new ClientPlatform(discord, { current: null });
        await assert.rejects(platform.react('fluxer', F, THUMBS), /not ready/);
    });

    it('walks a thread up to its channel and category', async () => {
        const parents: Record<string, string | null> = {
            thread: 'chan',
            chan: 'cat',
            cat: null,
        };
        const cached = new Map([['thread', { parentId: 'chan' }]]);
        const discord = {
            channels: {
                cache: cached,
                fetch: async (id: string) => {
                    if (id === 'gone') throw new Error('Unknown Channel');
                    return { parentId: parents[id] ?? null };
                },
            },
        } as unknown as DiscordClient;
        const platform = new ClientPlatform(discord, { current: null });
        assert.deepEqual(await platform.discordLineage('thread'), [
            'thread',
            'chan',
            'cat',
        ]);
        assert.deepEqual(await platform.discordLineage('gone'), ['gone']);
    });
});

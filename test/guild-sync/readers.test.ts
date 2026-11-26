import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client as DiscordClient } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';
import type { NonThreadGuildBasedChannel } from 'discord.js';
import {
    DiscordGuildReader,
    MAX_ARCHIVE_PAGES,
    discordChannel,
} from '../../src/guild-sync/readers/discord';
import { FluxerGuildReader } from '../../src/guild-sync/readers/fluxer';

/** A private thread as either library returns it. */
function thread(id: string) {
    return {
        id,
        type: 12,
        parentId: 'c1',
        name: `thread ${id}`,
        archived: true,
        locked: false,
        appliedTags: [],
        invitable: true,
        flags: { has: () => false },
        rateLimitPerUser: 0,
        autoArchiveDuration: 1440,
        archiveTimestamp: `ts-${id}`,
        lastMessageId: `last-${id}`,
    };
}

/**
 * Pages of archived private threads: `pages` pages of one thread each,
 * the last without more. Public archives are empty.
 */
function archive(pages: number, asList: boolean) {
    const calls: { type: string; before: unknown }[] = [];
    const fetchArchived = async (options: {
        type: string;
        before?: unknown;
    }) => {
        calls.push({ type: options.type, before: options.before });
        if (options.type !== 'private') {
            return asList
                ? { threads: [], hasMore: false }
                : { threads: collection([]), hasMore: false };
        }
        const page = calls.filter((c) => c.type === 'private').length;
        const found = [thread(`p${page}`)];
        const hasMore = page < pages;
        return asList
            ? { threads: found, hasMore }
            : { threads: collection(found), hasMore };
    };
    return { calls, fetchArchived };
}

function collection<T>(items: T[]) {
    return {
        values: () => items.values(),
        last: () => items[items.length - 1],
    };
}

function discordClient(pages: number) {
    const { fetchArchived } = archive(pages, false);
    const text = {
        id: 'c1',
        type: 0,
        name: 'general',
        rawPosition: 0,
        parentId: null,
        topic: null,
        nsfw: false,
        rateLimitPerUser: 0,
        permissionOverwrites: { cache: { map: () => [] } },
        permissionsFor: () => ({ has: () => true }),
        threads: { fetchArchived },
    };
    const guild = {
        id: 'g1',
        name: 'Server',
        available: true,
        icon: null,
        banner: null,
        channels: {
            fetch: async () => [text],
            fetchActiveThreads: async () => ({ threads: new Map() }),
        },
        roles: { fetch: async () => [] },
        emojis: { fetch: async () => [] },
        stickers: { fetch: async () => [] },
        members: { fetchMe: async () => ({}) },
    };
    return {
        isReady: () => true,
        guilds: { fetch: async () => guild },
    } as unknown as DiscordClient;
}

function fluxerClient(pages: number) {
    const { fetchArchived } = archive(pages, true);
    const text = {
        id: 'c1',
        type: 0,
        name: 'general',
        position: 0,
        parentId: null,
        permissionOverwrites: [],
        threads: { fetchArchived },
    };
    const guild = {
        id: 'g1',
        name: 'Server',
        available: true,
        icon: null,
        banner: null,
        features: [],
        ownerId: 'bot',
        fetchChannels: async () => [text],
        fetchRoles: async () => [],
        fetchEmojis: async () => [],
        fetchStickers: async () => [],
        fetchMe: async () => ({ id: 'bot', roles: { roleIds: [] } }),
        fetchActiveThreads: async () => ({ threads: [] }),
    };
    return {
        isReady: () => true,
        guilds: { fetch: async () => guild },
    } as unknown as FluxerClient;
}

describe('archived private threads', () => {
    it('pages through Discord private archives', async () => {
        const read = await new DiscordGuildReader(discordClient(3)).read('g1');
        assert.ok(read.ok);
        assert.deepEqual(read.snapshot.threads.map((t) => t.id).sort(), [
            'p1',
            'p2',
            'p3',
        ]);
        assert.deepEqual(read.snapshot.privateThreadGaps, []);
    });

    it('reports a Discord private archive past the page limit as a gap', async () => {
        const reader = new DiscordGuildReader(
            discordClient(MAX_ARCHIVE_PAGES + 1)
        );
        const read = await reader.read('g1');
        assert.ok(read.ok);
        assert.deepEqual(read.snapshot.privateThreadGaps, ['c1']);
    });

    it('pages through Fluxer private archives with the same gap rule', async () => {
        const all = await new FluxerGuildReader({
            current: fluxerClient(2),
        }).read('g1');
        assert.ok(all.ok);
        assert.equal(all.snapshot.threads.length, 2);
        assert.deepEqual(all.snapshot.privateThreadGaps, []);
        const deep = await new FluxerGuildReader({
            current: fluxerClient(MAX_ARCHIVE_PAGES + 1),
        }).read('g1');
        assert.ok(deep.ok);
        assert.deepEqual(deep.snapshot.privateThreadGaps, ['c1']);
    });
});

describe('thread activity', () => {
    it("reads each thread's newest message on both platforms", async () => {
        const discord = await new DiscordGuildReader(discordClient(1)).read(
            'g1'
        );
        const fluxer = await new FluxerGuildReader({
            current: fluxerClient(1),
        }).read('g1');
        assert.ok(discord.ok && fluxer.ok);
        for (const read of [discord, fluxer]) {
            assert.deepEqual(
                read.snapshot.threads.map((t) => t.lastMessageId),
                ['last-p1']
            );
        }
    });
});

describe('media channels on Discord', () => {
    it('reads their tags and post settings, without a layout', () => {
        const media = {
            id: 'm1',
            type: 16,
            name: 'gallery',
            rawPosition: 0,
            parentId: null,
            topic: null,
            nsfw: false,
            rateLimitPerUser: 0,
            permissionOverwrites: { cache: { map: () => [] } },
            availableTags: [
                { id: 't1', name: 'art', moderated: false, emoji: null },
            ],
            defaultReactionEmoji: { id: null, name: '🔥' },
            defaultSortOrder: 1,
            defaultAutoArchiveDuration: 4320,
            defaultThreadRateLimitPerUser: 0,
        } as unknown as NonThreadGuildBasedChannel;
        const snap = discordChannel(media);
        assert.deepEqual(snap.tags, ['art']);
        assert.deepEqual(snap.forum, {
            defaultReaction: { emojiId: null, emojiName: '🔥' },
            sortOrder: 1,
            layout: null,
            tags: [
                {
                    name: 'art',
                    moderated: false,
                    emojiId: null,
                    emojiName: null,
                },
            ],
        });
    });
});

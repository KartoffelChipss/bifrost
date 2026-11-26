import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    CATCH_UP_MS,
    dueChannels,
    targetsFrom,
    type Target,
} from '../../src/archive/targets';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import { progress } from './fakes';

function snapshot(): GuildSnapshot {
    const channel = (id: string, type: number, parentId: string | null) => ({
        id,
        type,
        name: id,
        position: 0,
        parentId,
        topic: null,
        nsfw: false,
        rateLimitPerUser: 0,
        bitrate: null,
        userLimit: null,
        overwrites: [],
        tags: [],
    });
    const thread = (id: string, parentId: string) => ({
        id,
        parentId,
        name: id,
        archived: false,
        locked: false,
        tags: [],
        lastMessageId: '900',
    });
    return {
        guildId: '100',
        channels: [
            channel('c1', 4, null),
            channel('t1', 0, 'c1'),
            channel('t2', 0, 'c2'),
            channel('v1', 2, null),
            channel('f1', 15, null),
        ],
        threads: [
            thread('th1', 't1'),
            thread('th2', 'f1'),
            thread('th3', 't2'),
        ],
    } as unknown as GuildSnapshot;
}

describe('targetsFrom', () => {
    it('takes message channels and threads, skipping categories and forums', () => {
        const ids = targetsFrom(snapshot(), new Set()).map((t) => t.channelId);
        assert.deepEqual(ids, ['t1', 't2', 'v1', 'th1', 'th2', 'th3']);
    });

    it('honours excluded channels and categories, and their threads', () => {
        const ids = targetsFrom(snapshot(), new Set(['c1', 't2'])).map(
            (t) => t.channelId
        );
        assert.deepEqual(ids, ['v1', 'th2']);
    });
});

describe('dueChannels', () => {
    const NOW = new Date('2026-11-26T12:00:00Z');
    const target = (
        channelId: string,
        lastMessageId: string | null
    ): Target => ({
        channelId,
        guildId: '100',
        kind: 'thread',
        parentId: 't1',
        lastMessageId,
    });
    const old = new Date(NOW.getTime() - CATCH_UP_MS - 1);

    it('puts unfinished walks first, then channels due a catch-up', () => {
        const due = dueChannels(
            [
                progress({
                    channelId: 'a',
                    status: 'current',
                    walkedAt: old,
                    afterId: '5',
                }),
                progress({ channelId: 'b', status: 'walking' }),
            ],
            [target('a', null), target('b', null)],
            NOW
        );
        assert.deepEqual(
            due.map((p) => p.channelId),
            ['b', 'a']
        );
    });

    it('skips recent, archived-up-to-date, failed, forbidden and vanished channels', () => {
        const recent = new Date(NOW.getTime() - 1_000);
        const due = dueChannels(
            [
                progress({
                    channelId: 'recent',
                    status: 'current',
                    walkedAt: recent,
                }),
                progress({
                    channelId: 'same',
                    status: 'current',
                    walkedAt: old,
                    afterId: '900',
                }),
                progress({ channelId: 'failed', status: 'failed' }),
                progress({ channelId: 'forbidden', status: 'forbidden' }),
                progress({ channelId: 'gone', status: 'walking' }),
                progress({
                    channelId: 'newer',
                    status: 'current',
                    walkedAt: old,
                    afterId: '899',
                }),
            ],
            ['recent', 'same', 'failed', 'forbidden', 'newer'].map((id) =>
                target(id, '900')
            ),
            NOW
        );
        assert.deepEqual(
            due.map((p) => p.channelId),
            ['newer']
        );
    });
});

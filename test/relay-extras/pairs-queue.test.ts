import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ThreadMessage } from '../../src/guild-sync/store';
import { historyPair } from '../../src/relay-extras/historyPairs';
import { excludingChannels, pairFinder } from '../../src/relay-extras/pairs';
import { KeyedQueue } from '../../src/relay-extras/queue';
import { PAIR } from './fakes';

const THREAD: ThreadMessage = {
    guildLinkId: 'link-2',
    discordThreadId: 'd-thread',
    fluxerThreadId: 'f-thread',
    discordMessageId: 'd-reply',
    fluxerMessageId: 'f-reply',
};

describe('pairFinder', () => {
    const lookups: string[] = [];
    const find = pairFinder({
        async bridgedMessage(side, id) {
            lookups.push(`bridged ${side} ${id}`);
            return PAIR[side].messageId === id ? PAIR : null;
        },
        async threadMessage(side, id) {
            lookups.push(`thread ${side} ${id}`);
            const key =
                side === 'discord' ? 'discordMessageId' : 'fluxerMessageId';
            return THREAD[key] === id ? THREAD : null;
        },
    });

    it('finds a message of a bridged channel in message_links', async () => {
        lookups.length = 0;
        assert.equal(await find('discord', 'd-msg'), PAIR);
        assert.deepEqual(lookups, ['bridged discord d-msg']);
    });

    it('falls back to a synced thread message', async () => {
        assert.deepEqual(await find('fluxer', 'f-reply'), {
            guildLinkId: 'link-2',
            discord: { channelId: 'd-thread', messageId: 'd-reply' },
            fluxer: { channelId: 'f-thread', messageId: 'f-reply' },
        });
    });

    it('returns null for a message that was not relayed', async () => {
        assert.equal(await find('discord', 'nope'), null);
    });

    it('falls back to an imported history copy', async () => {
        const IMPORTED = {
            guildLinkId: 'link-3',
            discord: { channelId: 'd-old', messageId: 'd-past' },
            fluxer: { channelId: 'f-old', messageId: 'f-past' },
        };
        const withHistory = pairFinder({
            bridgedMessage: async () => null,
            threadMessage: async () => null,
            historyMessage: async (side, id) =>
                IMPORTED[side].messageId === id ? IMPORTED : null,
        });
        assert.equal(await withHistory('fluxer', 'f-past'), IMPORTED);
        assert.equal(await withHistory('discord', 'd-past'), IMPORTED);
        assert.equal(await withHistory('discord', 'nope'), null);
    });
});

describe('historyPair', () => {
    const row = {
        guildLinkId: 'gl',
        discordId: 'd-chan',
        discordMessageId: 'd-msg',
        fluxerTargetId: 'f-thread',
        fluxerMessageId: 'f-msg',
    };

    it('pairs the original in its job channel with the copy in its target', () => {
        assert.deepEqual(historyPair(row), {
            guildLinkId: 'gl',
            discord: { channelId: 'd-chan', messageId: 'd-msg' },
            fluxer: { channelId: 'f-thread', messageId: 'f-msg' },
        });
    });

    it('skips a copy that was never finished', () => {
        assert.equal(historyPair({ ...row, fluxerMessageId: null }), null);
        assert.equal(historyPair({ ...row, fluxerTargetId: '' }), null);
    });
});

describe('excludingChannels', () => {
    const lineage = async (id: string) =>
        id === 'd-chan' ? ['d-chan', 'd-category'] : [id];
    const always = async () => PAIR;

    it('leaves out a pair whose channel or category is excluded', async () => {
        for (const excluded of ['d-chan', 'd-category']) {
            const find = excludingChannels(
                always,
                new Set([excluded]),
                lineage
            );
            assert.equal(await find('fluxer', 'f-msg'), null);
        }
    });

    it('keeps other pairs, and skips the lookup when nothing is excluded', async () => {
        const find = excludingChannels(always, new Set(['other']), lineage);
        assert.equal(await find('discord', 'd-msg'), PAIR);
        const none = excludingChannels(always, new Set(), async () => {
            throw new Error('not called');
        });
        assert.equal(await none('discord', 'd-msg'), PAIR);
    });
});

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('KeyedQueue', () => {
    it('runs tasks of one key in order and others in parallel', async () => {
        const queue = new KeyedQueue();
        const log: string[] = [];
        const task = (name: string, ms: number) => async () => {
            await new Promise((r) => setTimeout(r, ms));
            log.push(name);
        };
        await Promise.all([
            queue.run('a', task('a1', 10)),
            queue.run('a', task('a2', 0)),
            queue.run('b', task('b1', 0)),
        ]);
        assert.deepEqual(log, ['b1', 'a1', 'a2']);
    });

    it('runs the next task after a failure and reports the failure', async () => {
        const queue = new KeyedQueue();
        const first = queue.run('a', async () => {
            throw new Error('boom');
        });
        let ran = false;
        const second = queue.run('a', async () => {
            ran = true;
        });
        await assert.rejects(first, /boom/);
        await second;
        assert.equal(ran, true);
    });

    it('forgets a key once its work is done', async () => {
        const queue = new KeyedQueue();
        await queue.run('a', async () => undefined);
        await tick();
        assert.equal(queue.size, 0);
    });
});

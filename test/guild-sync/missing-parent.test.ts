import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diff } from '../../src/guild-sync/diff';
import { channel, discordGuild, fluxerGuild, mapRow } from './fixtures';

describe('children of a parent deleted on Fluxer', () => {
    it('plans no creates under a missing category, with one finding', () => {
        const result = diff({
            source: discordGuild({
                channels: [
                    channel('cat', { type: 4 }),
                    channel('a', { parentId: 'cat' }),
                    channel('b', { parentId: 'cat' }),
                    channel('top'),
                ],
            }),
            destination: fluxerGuild(),
            previousSource: null,
            rows: [mapRow('category', 'cat', 'f-cat')],
            direction: 'discord-to-fluxer',
        });
        const creates = result.ops.filter((op) => op.op === 'create');
        assert.deepEqual(
            creates.map((op) => ('sourceId' in op ? op.sourceId : '')),
            ['top']
        );
        const waiting = result.findings.filter((f) =>
            f.detail.includes('its children wait')
        );
        assert.equal(waiting.length, 1);
        assert.equal(waiting[0].id, 'f-cat');
    });

    it('plans no thread creates under a missing channel', () => {
        const thread = {
            id: 't1',
            parentId: 'c1',
            name: 'thread',
            archived: false,
            locked: false,
            tags: [],
        };
        const result = diff({
            source: discordGuild({
                channels: [channel('c1')],
                threads: [thread, { ...thread, id: 't2' }],
            }),
            destination: fluxerGuild(),
            previousSource: null,
            rows: [mapRow('channel', 'c1', 'f-c1')],
            direction: 'discord-to-fluxer',
        });
        assert.equal(result.ops.filter((op) => op.op === 'create').length, 0);
        assert.equal(
            result.findings.filter((f) => f.detail.includes('children wait'))
                .length,
            1
        );
    });
});

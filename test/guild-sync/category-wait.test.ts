import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diff } from '../../src/guild-sync/diff';
import { channel, discordGuild, fluxerGuild } from './fixtures';
import { setup } from './harness';

/**
 * A channel is never created outside its category. When the category is
 * not created this cycle, its channels wait for it.
 */

const source = () =>
    discordGuild({
        channels: [
            channel('cat', { type: 4, name: 'General Chat' }),
            channel('a', { name: 'a', parentId: 'cat' }),
            channel('top', { name: 'top' }),
        ],
    });

const creates = (ops: readonly { op: string; sourceId?: string }[]) =>
    ops.filter((op) => op.op === 'create').map((op) => op.sourceId);

describe('channels whose category is not created', () => {
    it('wait while a same-named Fluxer category blocks the create', () => {
        const result = diff({
            source: source(),
            destination: fluxerGuild({
                channels: [channel('f-cat', { type: 4, name: 'General Chat' })],
            }),
            previousSource: null,
            rows: [],
            direction: 'discord-to-fluxer',
        });
        assert.deepEqual(creates(result.ops), ['cat', 'top']);
        const waiting = result.findings.filter(
            (f) => f.id === 'cat' && f.detail.includes('channels wait')
        );
        assert.equal(waiting.length, 1);
    });

    it('are created with a category this plan creates', () => {
        const result = diff({
            source: source(),
            destination: fluxerGuild(),
            previousSource: null,
            rows: [],
            direction: 'discord-to-fluxer',
        });
        assert.deepEqual(creates(result.ops), ['cat', 'a', 'top']);
    });

    it('are not created when the category create fails in the same run', async () => {
        const s = setup(source());
        s.guild.failCreates.add('General Chat');
        const { applied } = await s.cycle();
        assert.equal(applied?.failed, 1);
        const names = s.guild.snapshot.channels.map((c) => c.name);
        assert.ok(names.includes('top'));
        assert.ok(!names.includes('a'), 'a waits for its category');
        assert.ok(
            applied?.skipped.some(
                (sk) => sk.reason === 'its category is not on Fluxer yet'
            )
        );
    });
});

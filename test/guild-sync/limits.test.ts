import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diff } from '../../src/guild-sync/diff';
import { channel, discordGuild, fluxerGuild, mapRow } from './fixtures';
import { opCount, setup } from './harness';

function voiceDiff(features: string[]) {
    return diff({
        source: discordGuild({
            channels: [channel('v', { type: 2, bitrate: 384_000 })],
        }),
        destination: fluxerGuild({
            features,
            channels: [
                channel('fv', { type: 2, name: 'channel-v', bitrate: 96_000 }),
            ],
        }),
        previousSource: discordGuild({
            channels: [channel('v', { type: 2, bitrate: 96_000 })],
        }),
        rows: [mapRow('channel', 'v', 'fv')],
        direction: 'discord-to-fluxer',
    });
}

const channelOps = (result: ReturnType<typeof diff>) =>
    result.ops.filter((op) => op.kind === 'channel');

describe('voice bitrate', () => {
    it('compares against the bitrate Fluxer can hold', () => {
        const result = voiceDiff([]);
        assert.equal(channelOps(result).length, 0);
        assert.ok(!result.findings.some((f) => f.detail.includes('bitrate')));
    });

    it('follows a higher cap from an audio bitrate feature', () => {
        const result = voiceDiff(['AUDIO_BITRATE_384_KBPS']);
        const update = channelOps(result).find((op) => op.op === 'update');
        assert.ok(update && update.op === 'update');
        assert.deepEqual(update.changes, [
            { field: 'bitrate', from: 96_000, to: 384_000 },
        ]);
    });
});

describe('sticker tags', () => {
    it('writes a tag-only change and then settles', async () => {
        const sticker = {
            id: 's1',
            name: 'wave',
            description: 'hi',
            tags: 'a',
        };
        const s = setup(discordGuild({ stickers: [sticker] }));
        await s.cycle();
        s.discord.result = {
            ok: true,
            snapshot: discordGuild({ stickers: [{ ...sticker, tags: 'b' }] }),
        };
        const second = await s.cycle();
        assert.equal(second.applied?.applied, 1);
        assert.deepEqual(s.guild.snapshot.stickers[0], {
            ...sticker,
            id: s.guild.snapshot.stickers[0].id,
            tags: 'b',
        });
        const third = await s.cycle();
        assert.equal(opCount(third.plan), 0);
    });
});

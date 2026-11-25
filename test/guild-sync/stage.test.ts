import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channel, discordGuild } from './fixtures';
import { opCount, setup } from './harness';

describe('stage channels', () => {
    it('are copied as voice channels, with one finding each', async () => {
        const s = setup(
            discordGuild({
                channels: [
                    channel('101'),
                    channel('stage', {
                        type: 13,
                        name: 'town-hall',
                        bitrate: 64_000,
                        userLimit: 50,
                    }),
                ],
            })
        );
        const first = await s.cycle();
        const copy = s.guild.snapshot.channels.find(
            (c) => c.name === 'town-hall'
        );
        assert.equal(copy?.type, 2);
        assert.equal(copy?.bitrate, 64_000);
        assert.equal(copy?.userLimit, 50);
        const notes = first.plan.body.findings.filter((f) => f.id === 'stage');
        assert.equal(notes.length, 1);
        assert.match(notes[0].detail, /voice channel on Fluxer/);
        // The second cycle places the new channels; then nothing is left.
        await s.cycle();
        const third = await s.cycle();
        assert.equal(opCount(third.plan), 0);
    });
});

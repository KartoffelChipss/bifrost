import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channel, discordGuild } from './fixtures';
import { setup } from './harness';

const threeChannels = () =>
    discordGuild({
        channels: ['a', 'b', 'c'].map((id) => channel(id, { name: id })),
    });

/** Changes the link's settings right after the first channel create. */
function flipAfterFirstCreate(s: ReturnType<typeof setup>, change: () => void) {
    const create = s.guild.createChannel.bind(s.guild);
    s.guild.createChannel = async (guildId, spec) => {
        const id = await create(guildId, spec);
        change();
        return id;
    };
}

describe('link settings read again during a run', () => {
    it('stops at the next write once the kill switch is on', async () => {
        const s = setup(threeChannels());
        flipAfterFirstCreate(s, () => {
            s.store.settings = { ...s.store.settings, killSwitch: true };
        });
        const { applied } = await s.cycle();
        assert.equal(s.guild.snapshot.channels.length, 1);
        assert.match(applied?.stopped ?? '', /kill switch/);
        assert.equal(s.store.plans[0].status, 'aborted');
    });

    it('stops at the next write once the link is set to dry-run', async () => {
        const s = setup(threeChannels());
        flipAfterFirstCreate(s, () => {
            s.store.settings = { ...s.store.settings, mode: 'dry-run' };
        });
        const { applied } = await s.cycle();
        assert.equal(s.guild.snapshot.channels.length, 1);
        assert.match(applied?.stopped ?? '', /dry-run/);
    });

    it('stops when the settings cannot be read again', async () => {
        const s = setup(threeChannels());
        flipAfterFirstCreate(s, () => {
            s.store.loadSettings = async () => {
                throw new Error('database is down');
            };
        });
        const { applied } = await s.cycle();
        assert.equal(s.guild.snapshot.channels.length, 1);
        assert.match(applied?.stopped ?? '', /could not be read/);
    });
});

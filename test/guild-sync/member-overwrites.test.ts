import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { runCycle } from '../../src/guild-sync/cycle';
import { D_GUILD, channel, discordGuild, role } from './fixtures';
import { LINK, setup } from './harness';

const VIEW = PermissionFlagsBits.ViewChannel.toString();

describe('member overwrites after an unlink', () => {
    it('removes the overwrite the sync wrote for a member who unlinked', async () => {
        const s = setup(
            discordGuild({
                roles: [role(D_GUILD, { permissions: VIEW })],
                channels: [
                    channel('c1', {
                        name: 'vip',
                        overwrites: [
                            { id: 'du1', type: 1, allow: VIEW, deny: '0' },
                        ],
                    }),
                ],
            })
        );
        let linked = new Map([['du1', 'fu1']]);
        const cycle = () =>
            runCycle(LINK, {
                ...s.depsFor(),
                linkedMembers: async () => linked,
            });
        const copy = () =>
            s.guild.snapshot.channels.find((c) => c.name === 'vip');
        await cycle();
        assert.deepEqual(copy()?.overwrites, [
            { id: 'fu1', type: 1, allow: VIEW, deny: '0' },
        ]);
        linked = new Map();
        await cycle();
        assert.deepEqual(copy()?.overwrites, []);
    });

    it('never touches a member overwrite the sync did not write', async () => {
        const s = setup(
            discordGuild({
                roles: [role(D_GUILD, { permissions: VIEW })],
                channels: [channel('c1', { name: 'vip' })],
            })
        );
        await s.cycle();
        const id = s.guild.snapshot.channels[0].id;
        await s.guild.updateChannel('', id, {
            overwrites: [{ id: 'stranger', type: 1, allow: VIEW, deny: '0' }],
        });
        const next = await s.cycle();
        assert.equal(next.plan.body.ops.length, 0);
        assert.equal(s.guild.snapshot.channels[0].overwrites.length, 1);
    });
});

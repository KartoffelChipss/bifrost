import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { D_GUILD, F_GUILD, channel, discordGuild, role } from './fixtures';
import { setup } from './harness';

const VIEW = PermissionFlagsBits.ViewChannel.toString();

describe('channel creates wait for the @everyone sync', () => {
    it('creates no channel while the @everyone update fails', async () => {
        const s = setup(
            discordGuild({
                roles: [role(D_GUILD, { permissions: VIEW })],
                channels: [channel('c1', { name: 'general' })],
            })
        );
        s.guild.failUpdates.add(F_GUILD);
        const first = await s.cycle();
        assert.equal(first.applied?.failed, 1);
        assert.equal(s.guild.snapshot.channels.length, 0);
        assert.ok(
            first.applied?.skipped.some((x) =>
                x.reason.includes('@everyone permission sync')
            )
        );
        s.guild.failUpdates.delete(F_GUILD);
        await s.cycle();
        assert.equal(s.guild.snapshot.channels.length, 1);
    });

    it('makes a channel private from birth when @everyone cannot view', async () => {
        const s = setup(
            discordGuild({
                roles: [role(D_GUILD, { permissions: '0' })],
                channels: [channel('c1', { name: 'secret' })],
            })
        );
        await s.cycle();
        const copy = s.guild.snapshot.channels.find((c) => c.name === 'secret');
        assert.deepEqual(copy?.overwrites, [
            { id: F_GUILD, type: 0, allow: '0', deny: VIEW },
        ]);
        const second = await s.cycle();
        assert.equal(second.plan.body.ops.length, 0);
        assert.equal(
            second.plan.body.findings.filter((f) => f.type === 'drift').length,
            0
        );
    });

    it('adds no deny when the channel has its own @everyone overwrite', async () => {
        const s = setup(
            discordGuild({
                roles: [role(D_GUILD, { permissions: '0' })],
                channels: [
                    channel('c1', {
                        name: 'open',
                        overwrites: [
                            { id: D_GUILD, type: 0, allow: VIEW, deny: '0' },
                        ],
                    }),
                ],
            })
        );
        await s.cycle();
        const copy = s.guild.snapshot.channels.find((c) => c.name === 'open');
        assert.deepEqual(copy?.overwrites, [
            { id: F_GUILD, type: 0, allow: VIEW, deny: '0' },
        ]);
    });
});

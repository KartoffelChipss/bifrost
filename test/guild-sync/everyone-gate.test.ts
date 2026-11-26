import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { bitOf } from '../../src/guild-sync/permissions';
import {
    D_GUILD,
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    role,
} from './fixtures';
import { opCount, setup } from './harness';

const VIEW = PermissionFlagsBits.ViewChannel.toString();

const VIEW_BIT = bitOf(10);
const MENTION_EVERYONE = bitOf(17);
/** View Channel, Manage Channels and Manage Roles. */
const BOT_BITS = VIEW_BIT | bitOf(4) | bitOf(28);

/** A Fluxer server where the bot holds only BOT_BITS and is not owner. */
function botWithout(s: ReturnType<typeof setup>): void {
    s.guild.snapshot = fluxerGuild({
        roles: [
            role(F_GUILD, { name: '@everyone', position: 0 }),
            role('f-bot', { permissions: BOT_BITS.toString() }),
        ],
        bot: { userId: 'bot', roleIds: ['f-bot'], isOwner: false },
    });
    const update = s.guild.updateRole.bind(s.guild);
    // Like Fluxer (GuildRoleService.resolveRequestedPermissions), refuse
    // a role update that grants a bit the bot lacks.
    s.guild.updateRole = async (guildId, roleId, patch) => {
        const asked = BigInt(patch.permissions ?? '0');
        if ((asked & ~BOT_BITS) !== BigInt(0)) {
            throw Object.assign(new Error('Missing Permissions'), {
                statusCode: 403,
            });
        }
        return update(guildId, roleId, patch);
    };
}

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

    it('syncs only the bits the bot may grant, so channels are still created', async () => {
        const everyone = (VIEW_BIT | MENTION_EVERYONE).toString();
        const s = setup(
            discordGuild({
                roles: [role(D_GUILD, { permissions: everyone })],
                channels: [channel('c1', { name: 'general' })],
            })
        );
        botWithout(s);
        const first = await s.cycle();
        assert.equal(first.applied?.failed, 0);
        const copy = s.guild.snapshot.roles.find((r) => r.id === F_GUILD);
        assert.equal(copy?.permissions, VIEW_BIT.toString());
        assert.ok(s.guild.snapshot.channels.some((c) => c.name === 'general'));
        assert.ok(
            first.plan.body.findings.some(
                (f) =>
                    f.type === 'not-held-by-bot' &&
                    f.detail.includes('MentionEveryone')
            )
        );
        const second = await s.cycle();
        assert.equal(opCount(second.plan), 0);
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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import {
    describeStatus,
    parseSyncCommand,
    runSyncCommand,
} from '../../src/guild-sync/command';
import { FLUXER_ONLY_BITS, bitOf } from '../../src/guild-sync/permissions';
import { DEFAULT_SETTINGS, FakeStore } from './fake-store';
import { D_GUILD, F_GUILD, channel, discordGuild, role } from './fixtures';
import { LINK, opCount, setup } from './harness';

const VIEW = PermissionFlagsBits.ViewChannel.toString();

const source = () =>
    discordGuild({
        roles: [
            role(D_GUILD, { permissions: VIEW }),
            role('r1', { name: 'Mods', permissions: VIEW }),
        ],
        channels: [channel('c1', { name: 'chat' })],
    });

describe('sync enforce', () => {
    it('parses on and off, and nothing else', () => {
        assert.deepEqual(parseSyncCommand(['enforce', 'on']), {
            type: 'enforce',
            on: true,
        });
        assert.deepEqual(parseSyncCommand(['enforce', 'off']), {
            type: 'enforce',
            on: false,
        });
        assert.equal(parseSyncCommand(['enforce', 'maybe']).type, 'error');
    });

    it('stores the setting and shows it in the status', async () => {
        const store = new FakeStore();
        const error = await runSyncCommand(
            { type: 'enforce', on: true },
            LINK,
            'any',
            { store, isChannelLinked: async () => false, now: () => new Date() }
        );
        assert.equal(error, null);
        assert.equal(store.settings.enforceDrift, true);
        assert.match(describeStatus(store.settings, true, null), /enforced/);
        assert.match(
            describeStatus(DEFAULT_SETTINGS, true, null),
            /Drift: \*\*reported\*\*/
        );
    });
});

describe('drift enforcement', () => {
    it('reports drift while off and reverts it once on', async () => {
        const s = setup(source());
        await s.cycle();
        const copy = s.guild.snapshot.channels[0];
        await s.guild.updateChannel(F_GUILD, copy.id, { name: 'hand-edit' });
        const reported = await s.cycle();
        assert.equal(opCount(reported.plan), 0);
        assert.equal(s.guild.snapshot.channels[0].name, 'hand-edit');

        await s.store.setEnforceDrift(LINK.id, true);
        await s.cycle();
        assert.equal(s.guild.snapshot.channels[0].name, 'chat');
        const settled = await s.cycle();
        assert.equal(opCount(settled.plan), 0);
    });

    it('keeps unmanaged bits and objects when it reverts', async () => {
        const s = setup(source());
        await s.store.setEnforceDrift(LINK.id, true);
        await s.cycle();
        const mods = s.guild.snapshot.roles.find((r) => r.name === 'Mods');
        assert.ok(mods);
        const fluxerOnly = bitOf(FLUXER_ONLY_BITS.ViewChannelMembers);
        // A hand edit: a managed bit added, a Fluxer-only bit added, and
        // a role the sync does not own.
        const edited =
            BigInt(VIEW) | PermissionFlagsBits.KickMembers | fluxerOnly;
        await s.guild.updateRole(F_GUILD, mods.id, {
            permissions: edited.toString(),
        });
        await s.guild.createRole(F_GUILD, {
            name: 'theirs',
            color: 0,
            hoist: false,
            mentionable: false,
            permissions: '8',
        });
        await s.cycle();
        const after = s.guild.snapshot.roles.find((r) => r.id === mods.id);
        assert.equal(
            after?.permissions,
            (BigInt(VIEW) | fluxerOnly).toString()
        );
        const theirs = s.guild.snapshot.roles.find((r) => r.name === 'theirs');
        assert.equal(theirs?.permissions, '8');
    });
});

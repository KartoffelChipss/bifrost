import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { roleChanges, syncableRoles } from '../../src/identity/roles';
import { D_GUILD, discordGuild, mapRow, role } from '../guild-sync/fixtures';

const bits = (value: bigint) => value.toString();

describe('syncableRoles', () => {
    it('keeps mapped plain roles and drops privileged, managed and unmapped ones', () => {
        const source = discordGuild({
            roles: [
                role(D_GUILD),
                role('gamer'),
                role('mod', {
                    permissions: bits(PermissionFlagsBits.KickMembers),
                }),
                role('admin', {
                    permissions: bits(PermissionFlagsBits.Administrator),
                }),
                role('bot', { managed: true }),
                role('unmapped'),
            ],
        });
        const rows = ['gamer', 'mod', 'admin', 'bot', D_GUILD].map((id) =>
            mapRow('role', id, `f-${id}`)
        );
        assert.deepEqual(
            [...syncableRoles(source, rows)],
            [['gamer', 'f-gamer']]
        );
    });
});

describe('roleChanges', () => {
    const syncable = new Map([
        ['a', 'fa'],
        ['b', 'fb'],
    ]);

    it('adds missing synced roles and removes stale ones, never touching others', () => {
        assert.deepEqual(
            roleChanges(['a', 'x'], ['fb', 'fluxer-only'], syncable),
            {
                add: ['fa'],
                remove: ['fb'],
            }
        );
    });

    it('changes nothing when the roles already match', () => {
        assert.deepEqual(roleChanges(['a', 'b'], ['fa', 'fb'], syncable), {
            add: [],
            remove: [],
        });
    });
});

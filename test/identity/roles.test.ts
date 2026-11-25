import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import {
    PRIVILEGED_BITS,
    managedRoles,
    roleChanges,
    syncableRoles,
} from '../../src/identity/roles';
import {
    D_GUILD,
    channel,
    discordGuild,
    mapRow,
    role,
} from '../guild-sync/fixtures';

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

describe('syncableRoles moderator rights', () => {
    const MODERATOR_FLAGS = [
        'ManageMessages',
        'ManageWebhooks',
        'ManageNicknames',
        'MentionEveryone',
        'ManageThreads',
        'ManageEvents',
        'ManageGuildExpressions',
        'ViewAuditLog',
        'MuteMembers',
        'DeafenMembers',
        'MoveMembers',
        'ModerateMembers',
        'KickMembers',
        'BanMembers',
        'Administrator',
        'ManageChannels',
        'ManageGuild',
        'ManageRoles',
        'PinMessages',
        'BypassSlowmode',
        'CreateGuildExpressions',
        'CreateEvents',
    ] as const;

    it('treats every moderator flag as privileged', () => {
        for (const flag of MODERATOR_FLAGS) {
            const bit = PermissionFlagsBits[flag];
            assert.notEqual(bit & PRIVILEGED_BITS, BigInt(0), flag);
        }
        const plain =
            PermissionFlagsBits.SendMessages |
            PermissionFlagsBits.ViewChannel |
            PermissionFlagsBits.AddReactions;
        assert.equal(plain & PRIVILEGED_BITS, BigInt(0));
    });

    it('drops a role with a moderator flag', () => {
        const source = discordGuild({
            roles: [
                role(D_GUILD),
                role('helper', {
                    permissions: bits(PermissionFlagsBits.ManageMessages),
                }),
            ],
        });
        assert.equal(
            syncableRoles(source, [mapRow('role', 'helper', 'f-helper')]).size,
            0
        );
    });

    it('drops a role that a channel overwrite gives a moderator flag', () => {
        const source = discordGuild({
            roles: [role(D_GUILD), role('vip'), role('reader')],
            channels: [
                channel('101', {
                    overwrites: [
                        {
                            id: 'vip',
                            type: 0,
                            allow: bits(PermissionFlagsBits.ManageMessages),
                            deny: '0',
                        },
                        {
                            id: 'reader',
                            type: 0,
                            allow: bits(PermissionFlagsBits.ViewChannel),
                            deny: bits(PermissionFlagsBits.ManageMessages),
                        },
                        {
                            id: 'reader',
                            type: 1,
                            allow: bits(PermissionFlagsBits.Administrator),
                            deny: '0',
                        },
                    ],
                }),
            ],
        });
        const rows = ['vip', 'reader'].map((id) =>
            mapRow('role', id, `f-${id}`)
        );
        assert.deepEqual(
            [...syncableRoles(source, rows)],
            [['reader', 'f-reader']]
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

describe('roles that became privileged', () => {
    const source = discordGuild({
        roles: [
            role(D_GUILD),
            role('gamer'),
            role('helper', {
                permissions: bits(PermissionFlagsBits.ManageMessages),
            }),
        ],
    });
    const rows = ['gamer', 'helper'].map((id) => mapRow('role', id, `f-${id}`));
    const syncable = syncableRoles(source, rows);
    const managed = managedRoles(source, rows);

    it('removes a privileged role the member lost on Discord, but never adds one', () => {
        assert.deepEqual([...managed.keys()], ['gamer', 'helper']);
        assert.deepEqual(
            roleChanges([], ['f-helper', 'f-gamer'], syncable, managed),
            { add: [], remove: ['f-gamer', 'f-helper'] }
        );
        assert.deepEqual(
            roleChanges(['helper', 'gamer'], [], syncable, managed),
            { add: ['f-gamer'], remove: [] }
        );
    });

    it('keeps a privileged role the member still holds on Discord', () => {
        assert.deepEqual(
            roleChanges(['helper'], ['f-helper'], syncable, managed),
            { add: [], remove: [] }
        );
    });
});

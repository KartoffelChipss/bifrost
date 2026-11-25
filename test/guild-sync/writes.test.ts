import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlags } from '@fluxerjs/util';
import { PermissionFlagsBits } from 'discord.js';
import { IdMap } from '../../src/guild-sync/idmap';
import type { PlanOp } from '../../src/guild-sync/ops';
import {
    mergeOverwrites,
    positionsFor,
    writeFor,
    type WriteContext,
} from '../../src/guild-sync/writes';
import {
    D_GUILD,
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    mapRow,
    role,
} from './fixtures';

const bits = (value: bigint) => value.toString();
const FLUXER_ONLY = bits(PermissionFlags.UpdateRtcRegion);

function context(overrides: Partial<WriteContext> = {}): WriteContext {
    const source = overrides.source ?? discordGuild();
    const destination = overrides.destination ?? fluxerGuild();
    return {
        source,
        destination,
        direction: 'discord-to-fluxer',
        map: new IdMap(
            [mapRow('role', 'r1', 'fr1')],
            'discord-to-fluxer',
            D_GUILD,
            F_GUILD
        ),
        ...overrides,
    };
}

const create = (
    kind: 'role' | 'channel' | 'emoji',
    sourceId: string
): PlanOp => ({
    op: 'create',
    kind,
    sourceId,
    name: sourceId,
    existingDestId: null,
});

describe('writeFor', () => {
    it('drops Discord-only permissions from a new role', () => {
        const permissions =
            PermissionFlagsBits.KickMembers | PermissionFlagsBits.UseSoundboard;
        const action = writeFor(
            create('role', 'r2'),
            context({
                source: discordGuild({
                    roles: [
                        role(D_GUILD),
                        role('r2', { permissions: bits(permissions) }),
                    ],
                }),
            })
        );
        assert.equal(action.type, 'create-role');
        assert.ok(action.type === 'create-role');
        assert.equal(
            action.spec.permissions,
            bits(PermissionFlags.KickMembers)
        );
    });

    it('maps overwrite roles and leaves out roles that are not synced', () => {
        const ow = (id: string) => ({
            id,
            type: 0 as const,
            allow: '1024',
            deny: '0',
        });
        const action = writeFor(
            create('channel', 'c1'),
            context({
                source: discordGuild({
                    channels: [
                        channel('c1', {
                            overwrites: [ow('r1'), ow('unmapped'), ow(D_GUILD)],
                        }),
                    ],
                }),
            })
        );
        assert.ok(action.type === 'create-channel');
        assert.deepEqual(
            action.spec.overwrites.map((o) => o.id).sort(),
            [F_GUILD, 'fr1'].sort()
        );
    });

    it('does not create over an existing object with the same name', () => {
        const action = writeFor(
            {
                op: 'create',
                kind: 'channel',
                sourceId: 'c1',
                name: 'c1',
                existingDestId: 'f9',
            },
            context()
        );
        assert.equal(action.type, 'skip');
    });

    it('never archives or deletes the server itself', () => {
        const ops: PlanOp[] = [
            {
                op: 'archive',
                kind: 'guild',
                sourceId: D_GUILD,
                destId: F_GUILD,
            },
            {
                op: 'hard-delete',
                kind: 'guild',
                sourceId: D_GUILD,
                destId: F_GUILD,
                adopted: false,
            },
        ];
        for (const op of ops) {
            assert.equal(writeFor(op, context()).type, 'skip', op.op);
        }
    });

    it('archives a role by renaming it and removing its permissions', () => {
        const action = writeFor(
            { op: 'archive', kind: 'role', sourceId: 'r1', destId: 'fr1' },
            context({
                destination: fluxerGuild({
                    roles: [
                        role(F_GUILD),
                        role('fr1', { name: 'Mods', permissions: '8' }),
                    ],
                }),
            })
        );
        assert.deepEqual(action, {
            type: 'archive-role',
            patch: { name: '[archived] Mods', permissions: '0' },
        });
    });

    it('locks an archived channel for @everyone and keeps its overwrites', () => {
        const action = writeFor(
            { op: 'archive', kind: 'channel', sourceId: 'c1', destId: 'f1' },
            context({
                destination: fluxerGuild({
                    channels: [
                        channel('f1', {
                            overwrites: [
                                {
                                    id: 'fr1',
                                    type: 0,
                                    allow: '1024',
                                    deny: '0',
                                },
                                {
                                    id: F_GUILD,
                                    type: 0,
                                    allow: bits(PermissionFlags.SendMessages),
                                    deny: bits(PermissionFlags.ViewChannel),
                                },
                            ],
                        }),
                    ],
                }),
            })
        );
        assert.ok(action.type === 'archive-channel' && action.move);
        const everyone = action.patch.overwrites?.find((o) => o.id === F_GUILD);
        assert.ok(everyone);
        assert.equal(BigInt(everyone.allow), BigInt(0));
        const denied = BigInt(everyone.deny);
        for (const flag of [
            PermissionFlags.ViewChannel,
            PermissionFlags.SendMessages,
            PermissionFlags.Connect,
            PermissionFlagsBits.SendMessagesInThreads,
        ]) {
            assert.equal(denied & flag, flag);
        }
        assert.ok(action.patch.overwrites?.some((o) => o.id === 'fr1'));
    });

    it('keeps destination-only bits when a role permission changes', () => {
        const action = writeFor(
            {
                op: 'update',
                kind: 'role',
                sourceId: 'r1',
                destId: 'fr1',
                changes: [{ field: 'permissions', from: '0', to: '2' }],
            },
            context({
                source: discordGuild({ roles: [role(D_GUILD), role('r1')] }),
                destination: fluxerGuild({
                    roles: [
                        role(F_GUILD),
                        role('fr1', { permissions: FLUXER_ONLY }),
                    ],
                }),
            })
        );
        assert.ok(action.type === 'update-role');
        assert.equal(
            action.patch.permissions,
            bits(BigInt(2) | PermissionFlags.UpdateRtcRegion)
        );
    });
});

describe('mergeOverwrites', () => {
    const map = new IdMap(
        [mapRow('role', 'r1', 'fr1'), mapRow('role', 'r2', 'fr2')],
        'discord-to-fluxer',
        D_GUILD,
        F_GUILD
    );

    it('replaces managed role overwrites and keeps the rest', () => {
        const merged = mergeOverwrites(
            [{ id: 'fr1', type: 0, allow: '1024', deny: '0' }],
            [
                { id: 'member', type: 1, allow: '1', deny: '0' },
                { id: 'hand-made-role', type: 0, allow: '2', deny: '0' },
                { id: 'fr1', type: 0, allow: FLUXER_ONLY, deny: '0' },
                { id: 'fr2', type: 0, allow: '4', deny: '0' },
            ],
            map
        );
        assert.deepEqual(merged, [
            { id: 'member', type: 1, allow: '1', deny: '0' },
            { id: 'hand-made-role', type: 0, allow: '2', deny: '0' },
            {
                id: 'fr1',
                type: 0,
                allow: bits(BigInt(1024) | PermissionFlags.UpdateRtcRegion),
                deny: '0',
            },
        ]);
    });
});

describe('positionsFor', () => {
    it('reuses the objects own slots in the wanted order', () => {
        const current = new Map([
            ['a', 5],
            ['b', 2],
            ['c', 9],
        ]);
        assert.deepEqual(positionsFor(['c', 'a', 'b'], current), [
            { id: 'c', position: 2 },
            { id: 'a', position: 5 },
            { id: 'b', position: 9 },
        ]);
    });

    it('spreads equal slots so the order can be expressed', () => {
        const current = new Map([
            ['a', 1],
            ['b', 1],
        ]);
        assert.deepEqual(positionsFor(['b', 'a'], current), [
            { id: 'b', position: 1 },
            { id: 'a', position: 2 },
        ]);
    });

    it('returns null when an object is gone', () => {
        assert.equal(positionsFor(['a'], new Map()), null);
    });
});

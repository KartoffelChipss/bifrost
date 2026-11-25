import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPlan, bucketOf } from '../../src/guild-sync/apply';
import { diff } from '../../src/guild-sync/diff';
import { ORDER_PENDING } from '../../src/guild-sync/order';
import type { PlanOp } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import { channelMoves } from '../../src/guild-sync/writes';
import { createRecordingLogger } from '../addons/fakes';
import { FakeGuild } from './fake-guild';
import { FakeAssets, FakeLinker, FakeStore } from './fake-store';
import {
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    mapRow,
} from './fixtures';
import { opCount, setup } from './harness';

describe('channel moves', () => {
    it('keeps unmanaged siblings in place and chains each move', () => {
        const channels = [
            channel('a', { position: 1 }),
            channel('x', { position: 2 }),
            channel('b', { position: 3 }),
        ];
        const { moves, placed } = channelMoves(['b', 'a'], channels, null);
        assert.deepEqual(placed, ['b', 'a']);
        assert.deepEqual(moves, [
            { id: 'b', precedingId: null },
            { id: 'a', precedingId: 'x' },
        ]);
    });

    it('passes Fluxer voice placement at every step inside a category', async () => {
        const guild = new FakeGuild(
            fluxerGuild({
                channels: [
                    channel('cat', { type: 4, position: 1 }),
                    channel('t1', { parentId: 'cat', position: 2 }),
                    channel('t2', { parentId: 'cat', position: 3 }),
                    channel('u', { parentId: 'cat', position: 4 }),
                    channel('v1', { type: 2, parentId: 'cat', position: 5 }),
                    channel('v2', { type: 2, parentId: 'cat', position: 6 }),
                ],
            })
        );
        const wanted = ['t2', 't1', 'v2', 'v1'];
        const { moves } = channelMoves(wanted, guild.snapshot.channels, 'cat');
        await guild.setChannelPositions(F_GUILD, moves);
        const order = guild.snapshot.channels
            .filter((c) => c.parentId === 'cat')
            .sort((a, b) => a.position - b.position)
            .map((c) => c.id);
        assert.deepEqual(order, ['t2', 't1', 'u', 'v2', 'v1']);
    });
});

describe('channel order inside a category', () => {
    it('keeps voice below text and reports the difference', () => {
        const result = diff({
            source: discordGuild({
                channels: [
                    channel('cat', { type: 4 }),
                    channel('v', { type: 2, parentId: 'cat', position: 0 }),
                    channel('t', { parentId: 'cat', position: 1 }),
                ],
            }),
            destination: fluxerGuild({
                channels: [
                    channel('fcat', { type: 4 }),
                    channel('fv', { type: 2, parentId: 'fcat', position: 2 }),
                    channel('ft', { parentId: 'fcat', position: 1 }),
                ],
            }),
            previousSource: null,
            rows: [
                mapRow('category', 'cat', 'fcat'),
                mapRow('channel', 'v', 'fv'),
                mapRow('channel', 't', 'ft'),
            ],
            direction: 'discord-to-fluxer',
        });
        assert.equal(
            result.ops.filter((op) => op.op === 'reorder').length,
            0,
            'text above voice already matches what Fluxer can show'
        );
        assert.ok(
            result.findings.some((f) =>
                f.detail.includes('Fluxer keeps voice channels below text')
            )
        );
    });

    it('creates, places and settles new channels in a category', async () => {
        const s = setup(
            discordGuild({
                channels: [
                    channel('cat', { type: 4, name: 'Cat' }),
                    channel('b', { name: 'b', parentId: 'cat', position: 2 }),
                    channel('a', { name: 'a', parentId: 'cat', position: 1 }),
                    channel('v', {
                        type: 2,
                        name: 'v',
                        parentId: 'cat',
                        position: 0,
                    }),
                ],
            })
        );
        await s.cycle();
        const second = await s.cycle();
        assert.equal(second.applied?.failed, 0);
        const pending = s.store.rows.filter(
            (r) => r.appliedFields?.[ORDER_PENDING] === true
        );
        assert.deepEqual(
            pending.map((r) => r.kind),
            ['category'],
            'only the lone category waits for a sibling'
        );
        const order = s.guild.snapshot.channels
            .filter((c) => c.parentId !== null)
            .sort((x, y) => x.position - y.position)
            .map((c) => c.name);
        assert.deepEqual(order, ['a', 'b', 'v']);
        const third = await s.cycle();
        assert.equal(opCount(third.plan), 0);
    });
});

describe('reorder failure bucket', () => {
    it('counts reorders apart, so failing reorders never block links', async () => {
        const guild = new FakeGuild(
            fluxerGuild({
                channels: ['a', 'b', 'c', 'd'].map((id, i) =>
                    channel(`f${id}`, { position: i })
                ),
            })
        );
        guild.setChannelPositions = async () => {
            throw new Error('refused');
        };
        const reorder = (scope: string): PlanOp => ({
            op: 'reorder',
            kind: 'channel',
            scope,
            destIds: ['fb', 'fa'],
        });
        assert.notEqual(bucketOf(reorder('top')), 'channel');
        const ops: PlanOp[] = [
            reorder('top'),
            reorder('top'),
            reorder('top'),
            { op: 'link', kind: 'channel', sourceId: 'c', destId: 'fc' },
        ];
        const plan: Plan = {
            id: 'p1',
            guildLinkId: 'link-1',
            direction: 'discord-to-fluxer',
            status: 'dry-run',
            body: {
                ops,
                deferred: [],
                findings: [],
                needsApproval: false,
                approvalReason: null,
            },
            abortReason: null,
        };
        const linker = new FakeLinker();
        const rows = ['a', 'b', 'c', 'd'].map((id) =>
            mapRow('channel', id, `f${id}`)
        );
        const result = await applyPlan(
            {
                plan,
                source: discordGuild({
                    channels: ['a', 'b', 'c', 'd'].map((id) => channel(id)),
                }),
                destination: guild.snapshot,
                rows,
            },
            {
                store: new FakeStore(),
                writer: guild,
                assets: new FakeAssets(),
                links: linker,
                threads: null,
                canWrite: () => true,
                pause: async () => undefined,
                now: () => new Date(),
                logger: createRecordingLogger(),
            }
        );
        assert.equal(result.failed, 3);
        assert.equal(linker.links.length, 1);
    });
});

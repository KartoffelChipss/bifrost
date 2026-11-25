import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    markAdoptions,
    snowflakeTime,
    type CreateIntent,
} from '../../src/guild-sync/adopt';
import { IdMap } from '../../src/guild-sync/idmap';
import type { PlanOp } from '../../src/guild-sync/ops';
import type { ThreadSnap } from '../../src/guild-sync/snapshot';
import {
    D_GUILD,
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    mapRow,
} from './fixtures';
import { NOW, opCount, setup } from './harness';

const EPOCH = 1420070400000;
/** A snowflake made at `time`. */
const flake = (time: Date) =>
    (BigInt(time.getTime() - EPOCH) << BigInt(22)).toString();
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const roleCreate = (existingDestId: string): PlanOp => ({
    op: 'create',
    kind: 'role',
    sourceId: 'r1',
    name: 'Mods',
    existingDestId,
});

const intent = (at: Date): CreateIntent => ({
    kind: 'role',
    sourceId: 'r1',
    name: 'Mods',
    at,
});

function adopt(ops: PlanOp[], intents: CreateIntent[]) {
    return markAdoptions({
        ops,
        intents,
        source: discordGuild(),
        destination: fluxerGuild(),
        map: new IdMap([], 'discord-to-fluxer', D_GUILD, F_GUILD),
    });
}

describe('snowflake times', () => {
    it('reads the creation time and rejects other IDs', () => {
        assert.equal(snowflakeTime(flake(NOW)), NOW.getTime());
        assert.equal(snowflakeTime('f-ch-1'), null);
    });
});

describe('adoption of an unrecorded create', () => {
    it('adopts a same-name object made after the intent', () => {
        const [op] = adopt([roleCreate(flake(minutes(1)))], [intent(NOW)]);
        assert.ok(op.op === 'create' && op.adopt === true);
    });

    it('leaves an object that existed before any intent', () => {
        const [op] = adopt([roleCreate(flake(minutes(-60)))], [intent(NOW)]);
        assert.ok(op.op === 'create' && op.adopt === undefined);
        const [none] = adopt([roleCreate(flake(minutes(1)))], []);
        assert.ok(none.op === 'create' && none.adopt === undefined);
    });

    it('adopts a create that timed out after Fluxer made the channel', async () => {
        const s = setup(
            discordGuild({ channels: [channel('c1', { name: 'general' })] })
        );
        const create = s.guild.createChannel.bind(s.guild);
        s.guild.createChannel = async (guildId, spec) => {
            const made = await create(guildId, spec);
            const id = flake(s.state.now);
            s.guild.snapshot = {
                ...s.guild.snapshot,
                channels: s.guild.snapshot.channels.map((c) =>
                    c.id === made ? { ...c, id } : c
                ),
            };
            throw new Error('Fluxer channel create timed out');
        };
        await s.cycle();
        s.guild.createChannel = create;
        s.wait(10);
        const second = await s.cycle();
        assert.ok(
            second.plan.body.ops.some((op) => op.op === 'create' && op.adopt)
        );
        assert.equal(s.guild.snapshot.channels.length, 1);
        const row = s.store.rows.find((r) => r.kind === 'channel');
        assert.equal(row?.createdBySync, true);
        assert.equal(row?.fluxerId, s.guild.snapshot.channels[0].id);
        s.wait(10);
        const third = await s.cycle();
        assert.equal(opCount(third.plan), 0);
    });

    it('adopts a thread made after its intent instead of a duplicate', () => {
        const thread: ThreadSnap = {
            id: 't1',
            parentId: 'c1',
            name: 'Patch notes',
            archived: false,
            locked: false,
            tags: [],
        };
        const made = { ...thread, id: flake(minutes(1)), parentId: 'f-c1' };
        const old = { ...made, id: flake(minutes(-60)) };
        const run = (dest: ThreadSnap[]) =>
            markAdoptions({
                ops: [
                    {
                        op: 'create',
                        kind: 'thread',
                        sourceId: 't1',
                        name: 'Patch notes',
                        existingDestId: null,
                    },
                ],
                intents: [
                    {
                        ...intent(NOW),
                        kind: 'thread',
                        sourceId: 't1',
                        name: 'Patch notes',
                    },
                ],
                source: discordGuild({ threads: [thread] }),
                destination: fluxerGuild({ threads: dest }),
                map: new IdMap(
                    [mapRow('channel', 'c1', 'f-c1')],
                    'discord-to-fluxer',
                    D_GUILD,
                    F_GUILD
                ),
            })[0];
        const adopted = run([made]);
        assert.ok(
            adopted.op === 'create' && adopted.existingDestId === made.id
        );
        const kept = run([old]);
        assert.ok(kept.op === 'create' && kept.adopt === undefined);
    });
});

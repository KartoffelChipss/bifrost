import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPlan, type ApplyDeps } from '../../src/guild-sync/apply';
import { runCycle } from '../../src/guild-sync/cycle';
import { diff } from '../../src/guild-sync/diff';
import { MemoryFailureLedger } from '../../src/guild-sync/failures';
import { orderAndCap } from '../../src/guild-sync/guards';
import type { MapRow, PlanOp } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import {
    MAX_BLOCKING_FAILURES,
    holdNewerPosts,
    oldestFirstPerParent,
} from '../../src/guild-sync/postOrder';
import type { GuildSnapshot, ThreadSnap } from '../../src/guild-sync/snapshot';
import { createRecordingLogger } from '../addons/fakes';
import { FakeGuild } from './fake-guild';
import { FakeAssets, FakeStore } from './fake-store';
import { channel, discordGuild, fluxerGuild, mapRow } from './fixtures';
import { LINK, NOW, setup } from './harness';

/** A thread named after its ID, in text channel `parentId`. */
const thread = (id: string, parentId: string): ThreadSnap => ({
    id,
    parentId,
    name: `t${id}`,
    archived: false,
    locked: false,
    tags: [],
});

const create = (sourceId: string): PlanOp => ({
    op: 'create',
    kind: 'thread',
    sourceId,
    name: `t${sourceId}`,
    existingDestId: null,
});

const createdIds = (ops: readonly PlanOp[]) =>
    ops.flatMap((op) =>
        op.op === 'create' && op.kind === 'thread' ? [op.sourceId] : []
    );

/** Text channels a and b, both mapped, with these threads. */
function source(threads: ThreadSnap[]): GuildSnapshot {
    return discordGuild({ channels: [channel('a'), channel('b')], threads });
}

const destination = () =>
    fluxerGuild({ channels: [channel('fa'), channel('fb')] });

const parentRows = () => [
    mapRow('channel', 'a', 'fa'),
    mapRow('channel', 'b', 'fb'),
];

function diffThreads(threads: ThreadSnap[], rows: MapRow[] = parentRows()) {
    return diff({
        source: source(threads),
        destination: destination(),
        previousSource: null,
        rows,
        direction: 'discord-to-fluxer',
    });
}

describe('thread creates in age order', () => {
    it('creates new threads oldest first within each parent', () => {
        const { ops } = diffThreads([
            thread('300', 'a'),
            thread('450', 'b'),
            thread('200', 'a'),
            thread('1000', 'b'),
            thread('99', 'b'),
        ]);
        // Each parent's places keep their order between parents.
        assert.deepEqual(createdIds(ops), ['200', '99', '300', '450', '1000']);
    });

    it('leaves mapped threads where they are', () => {
        const mapped = { ...thread('150', 'a'), name: 'renamed' };
        const sorted = oldestFirstPerParent(
            [thread('300', 'a'), mapped, thread('200', 'a')],
            (t) => t.id !== '150'
        );
        assert.deepEqual(
            sorted.map((t) => t.id),
            ['200', '150', '300']
        );
    });

    it('defers only the newest posts of a parent over the write cap', () => {
        const { ops } = diffThreads([
            thread('400', 'a'),
            thread('300', 'a'),
            thread('200', 'a'),
        ]);
        const capped = orderAndCap(ops, 2);
        assert.deepEqual(createdIds(capped.now), ['200', '300']);
        assert.deepEqual(createdIds(capped.deferred), ['400']);
    });
});

function planOf(ops: PlanOp[], deferred: PlanOp[] = []): Plan {
    return {
        id: 'p1',
        guildLinkId: LINK.id,
        direction: 'discord-to-fluxer',
        status: 'dry-run',
        body: {
            ops,
            deferred,
            findings: [],
            needsApproval: false,
            approvalReason: null,
        },
        abortReason: null,
    };
}

/** Applies thread creates 200 and 300 in a, 400 in b. */
async function applyThreads(
    options: {
        ops?: PlanOp[];
        deferred?: PlanOp[];
        failing?: string[];
        failures?: MemoryFailureLedger;
        rows?: MapRow[];
    } = {}
) {
    const guild = new FakeGuild(destination());
    for (const name of options.failing ?? []) guild.failCreates.add(name);
    const logger = createRecordingLogger();
    const deps: ApplyDeps = {
        store: new FakeStore(),
        writer: guild,
        assets: new FakeAssets(),
        links: null,
        threads: null,
        canWrite: () => true,
        failures: options.failures,
        pause: async () => undefined,
        now: () => NOW,
        logger,
    };
    const ops = options.ops ?? ['200', '300', '400'].map(create);
    const result = await applyPlan(
        {
            plan: planOf(ops, options.deferred),
            source: source([
                thread('200', 'a'),
                thread('300', 'a'),
                thread('400', 'b'),
            ]),
            destination: guild.snapshot,
            rows: options.rows ?? parentRows(),
        },
        deps
    );
    const created = guild.posts.map((p) => p.name);
    return { result, created, logger };
}

const key = (sourceId: string) => `${LINK.id}:create:thread:${sourceId}`;

/** A ledger where create `sourceId` failed `count` times long ago. */
function ledgerWith(sourceId: string, count: number, at = new Date(0)) {
    const ledger = new MemoryFailureLedger();
    for (let i = 0; i < count; i++) ledger.failed(key(sourceId), at);
    return ledger;
}

describe('newer posts wait for an older one', () => {
    it('holds newer posts in the parent of a failed one, not elsewhere', async () => {
        const { result, created } = await applyThreads({ failing: ['t200'] });
        assert.deepEqual(created, ['t400']);
        assert.equal(result.failed, 1);
        assert.equal(result.failures.length, 1);
        const waits = result.skipped.find(
            (s) => 'sourceId' in s.op && s.op.sourceId === '300'
        );
        assert.match(waits?.reason ?? '', /waits for an older post.*200/);
    });

    it('takes no failure slot for a post that waits', async () => {
        const ops = ['200', '300', '310', '320', '400'].map(create);
        const { result, created } = await applyThreads({
            ops,
            failing: ['t200'],
        });
        // Four waiting posts would pass MAX_FAILURES_PER_KIND if counted.
        assert.equal(result.failed, 1);
        assert.deepEqual(created, ['t400']);
    });

    it('holds newer posts behind one in a backoff', async () => {
        const failures = ledgerWith('200', 3, NOW);
        const { result, created } = await applyThreads({ failures });
        assert.deepEqual(created, ['t400']);
        assert.equal(result.failed, 0);
        assert.equal(result.skipped.length, 2);
    });

    it('holds newer posts behind one deferred over the write cap', async () => {
        const { created } = await applyThreads({
            ops: ['300', '400'].map(create),
            deferred: [create('200')],
        });
        assert.deepEqual(created, ['t400']);
    });

    it('lets newer posts go once an older one failed too often', async () => {
        const failures = ledgerWith('200', MAX_BLOCKING_FAILURES - 1);
        const { result, created, logger } = await applyThreads({
            failing: ['t200'],
            failures,
        });
        assert.equal(result.failed, 1);
        assert.deepEqual(created, ['t300', 't400']);
        assert.ok(
            logger.entries.some(
                (e) => e.level === 'warn' && /no longer wait/.test(e.message)
            )
        );
    });

    it('warns when a post lands after a newer one', async () => {
        const rows = [...parentRows(), mapRow('thread', '300', 'f300')];
        const { created, logger } = await applyThreads({
            ops: [create('200')],
            rows,
        });
        assert.deepEqual(created, ['t200']);
        assert.ok(
            logger.entries.some(
                (e) => e.level === 'warn' && /out of order/.test(e.message)
            )
        );
    });
});

describe('posts held at plan time', () => {
    const parents = new Map([
        ['200', 'a'],
        ['300', 'a'],
        ['400', 'b'],
    ]);
    const ops = ['200', '300', '400'].map(create);

    it('leaves newer posts behind a held one out of the plan', () => {
        const { kept, findings } = holdNewerPosts(ops, parents, (op) => ({
            held: op.sourceId === '200',
            failures: op.sourceId === '200' ? 3 : 0,
        }));
        assert.deepEqual(createdIds(kept), ['200', '400']);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].id, 'a');
        assert.match(findings[0].detail, /1 posts waits? for an older post/);
    });

    it('reports a post that failed too often and holds nothing for it', () => {
        const { kept, findings } = holdNewerPosts(ops, parents, (op) => ({
            held: op.sourceId === '200',
            failures: op.sourceId === '200' ? MAX_BLOCKING_FAILURES : 0,
        }));
        assert.deepEqual(createdIds(kept), ['200', '300', '400']);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].id, '200');
        assert.match(findings[0].detail, /out of order/);
    });
});

describe('post order across cycles', () => {
    it('waits for a failing post, then goes past it after repeated failures', async () => {
        const s = setup(
            discordGuild({
                channels: [channel('a', { name: 'chat' })],
                threads: [thread('300', 'a'), thread('200', 'a')],
            })
        );
        const failures = new MemoryFailureLedger();
        const logger = createRecordingLogger();
        const cycle = async () => {
            const outcome = await runCycle(LINK, {
                ...s.depsFor(),
                failures,
                logger,
            });
            assert.equal(outcome.status, 'planned');
            return outcome as Extract<typeof outcome, { status: 'planned' }>;
        };
        s.guild.failCreates.add('t200');
        await cycle();
        const names = () => s.guild.posts.map((p) => p.name);
        // Three failures in a row start the backoff.
        for (let i = 0; i < 3; i++) await cycle();
        assert.deepEqual(names(), []);
        const held = await cycle();
        // The waiting post takes no write-cap slot.
        assert.deepEqual(createdIds([...held.plan.body.ops]), ['200']);
        assert.ok(
            held.plan.body.findings.some((f) =>
                /waits? for an older post/.test(f.detail)
            )
        );
        for (let i = 0; i < 2; i++) {
            s.wait(24 * 60);
            await cycle();
        }
        assert.deepEqual(names(), ['t300']);
        s.guild.failCreates.delete('t200');
        s.wait(24 * 60);
        await cycle();
        assert.deepEqual(names(), ['t300', 't200']);
        assert.ok(logger.entries.some((e) => /out of order/.test(e.message)));
    });
});

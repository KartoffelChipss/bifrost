import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AddonTimeoutError } from '../../src/addons/host';
import { latestIntent, type CreateIntent } from '../../src/guild-sync/adopt';
import {
    ARCHIVE_KEY,
    applyPlan,
    isRefused,
    type ApplyDeps,
} from '../../src/guild-sync/apply';
import { OwnershipLostError } from '../../src/guild-sync/cycleGuard';
import { diff } from '../../src/guild-sync/diff';
import type { PlanOp } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import type { ChannelSnap, ThreadSnap } from '../../src/guild-sync/snapshot';
import { createRecordingLogger } from '../addons/fakes';
import { FakeGuild } from './fake-guild';
import {
    FakeAssets,
    FakeLinker,
    FakeStore,
    FakeThreadSource,
} from './fake-store';
import { channel, discordGuild, fluxerGuild, mapRow } from './fixtures';
import { NOW, setup } from './harness';

const EPOCH = 1420070400000;
/** A snowflake made at `time`. */
const flake = (time: Date) =>
    (BigInt(time.getTime() - EPOCH) << BigInt(22)).toString();
const later = (time: Date, minutes: number) =>
    new Date(time.getTime() + minutes * 60_000);

const refusal = () =>
    Object.assign(new Error('Missing Permissions'), { statusCode: 403 });

function planOf(ops: PlanOp[]): Plan {
    return {
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
}

function applyDeps(
    store: FakeStore,
    guild: FakeGuild,
    extra: Partial<ApplyDeps> = {}
): ApplyDeps {
    return {
        store,
        writer: guild,
        assets: new FakeAssets(),
        links: null,
        threads: null,
        canWrite: () => true,
        pause: async () => undefined,
        now: () => NOW,
        logger: createRecordingLogger(),
        ...extra,
    };
}

const forum = (id: string): ChannelSnap => channel(id, { type: 15 });
const post: ThreadSnap = {
    id: 'post1',
    parentId: 'forum',
    name: 'Patch notes',
    archived: false,
    locked: false,
    tags: [],
};

describe('forum posts that cannot be created yet', () => {
    const diffPosts = (bridged: ReadonlySet<string> | undefined) =>
        diff({
            source: discordGuild({
                channels: [forum('forum')],
                threads: [post],
            }),
            destination: fluxerGuild({ channels: [forum('fforum')] }),
            previousSource: null,
            rows: [mapRow('channel', 'forum', 'fforum')],
            direction: 'discord-to-fluxer',
            bridged,
        });

    it('plans no post in a forum that is not bridged, with one finding', () => {
        const held = diffPosts(new Set());
        assert.deepEqual(
            held.ops.filter((op) => op.kind === 'thread'),
            []
        );
        const findings = held.findings.filter((f) => f.id === 'forum');
        assert.equal(findings.length, 1);
        assert.match(findings[0].detail, /1 posts wait/);
        const bridged = diffPosts(new Set(['forum']));
        assert.ok(
            bridged.ops.some((op) => op.op === 'create' && op.kind === 'thread')
        );
    });

    it('records no create intent for a post that is not ready', async () => {
        const guild = new FakeGuild(
            fluxerGuild({ channels: [forum('fforum')] })
        );
        const store = new FakeStore();
        const rows = [mapRow('channel', 'forum', 'fforum')];
        const create: PlanOp = {
            op: 'create',
            kind: 'thread',
            sourceId: 'post1',
            name: 'Patch notes',
            existingDestId: null,
        };
        const result = await applyPlan(
            {
                plan: planOf([create]),
                source: discordGuild({
                    channels: [forum('forum')],
                    threads: [post],
                }),
                destination: guild.snapshot,
                rows,
            },
            applyDeps(store, guild, {
                links: new FakeLinker(),
                threads: new FakeThreadSource(),
            })
        );
        assert.equal(result.failed, 0);
        assert.match(result.skipped[0]?.reason ?? '', /not linked yet/);
        assert.deepEqual(
            store.audits.filter((a) => a.op === 'create-intent'),
            []
        );
    });
});

describe('intents of refused creates', () => {
    const entry = (at: Date, refused = false): CreateIntent => ({
        kind: 'channel',
        sourceId: 'c1',
        name: 'general',
        at,
        refused,
    });
    const key = { kind: 'channel' as const, sourceId: 'c1', name: 'general' };

    it('tells a refusal from an unclear outcome', () => {
        assert.equal(isRefused(refusal()), true);
        assert.equal(isRefused({ status: 429 }), true);
        assert.equal(isRefused({ status: 408 }), false);
        assert.equal(isRefused({ statusCode: 502 }), false);
        assert.equal(isRefused(new AddonTimeoutError('create', 30_000)), false);
    });

    it('drops an intent once a refusal follows it, until a newer intent', () => {
        assert.equal(latestIntent([entry(NOW), entry(NOW, true)], key), null);
        const retry = entry(later(NOW, 5));
        assert.equal(
            latestIntent([entry(NOW), entry(NOW, true), retry], key),
            retry
        );
    });

    it('never adopts a same-named object made after a refused create', async () => {
        const s = setup(
            discordGuild({ channels: [channel('c1', { name: 'general' })] })
        );
        const create = s.guild.createChannel.bind(s.guild);
        s.guild.createChannel = async () => {
            throw refusal();
        };
        await s.cycle();
        assert.ok(s.store.audits.some((a) => a.result === 'refused'));
        s.guild.createChannel = create;
        const handMade = flake(later(s.state.now, 1));
        s.guild.snapshot = {
            ...s.guild.snapshot,
            channels: [channel(handMade, { name: 'general' })],
        };
        s.wait(10);
        const second = await s.cycle();
        assert.ok(
            !second.plan.body.ops.some((op) => op.op === 'create' && op.adopt)
        );
        assert.ok(!s.store.rows.some((r) => r.fluxerId === handMade));
    });
});

describe('the archive category create', () => {
    const archive: PlanOp = {
        op: 'archive',
        kind: 'channel',
        sourceId: '1',
        destId: 'f1',
    };

    async function runArchive(guild: FakeGuild, store: FakeStore) {
        return applyPlan(
            {
                plan: planOf([archive]),
                source: discordGuild(),
                destination: guild.snapshot,
                rows: store.rows,
            },
            applyDeps(store, guild)
        );
    }

    function fresh() {
        const guild = new FakeGuild(
            fluxerGuild({ channels: [channel('f1', { name: 'old' })] })
        );
        const store = new FakeStore();
        store.rows = [mapRow('channel', '1', 'f1')];
        return { guild, store };
    }

    it('trips read-only when the new category cannot be recorded', async () => {
        const { guild, store } = fresh();
        store.insertMapping = async () => {
            throw new Error('database is down');
        };
        await assert.rejects(runArchive(guild, store), OwnershipLostError);
    });

    it('records an intent before it creates the category', async () => {
        const { guild, store } = fresh();
        await runArchive(guild, store);
        const intent = store.audits.find((a) => a.op === 'create-intent');
        assert.equal(intent?.kind, 'category');
        assert.equal(intent?.sourceId, `${ARCHIVE_KEY}:1`);
        assert.deepEqual(intent?.after, { name: 'archived-sync' });
    });

    it('adopts the category a timed-out create made, not a second one', async () => {
        const { guild, store } = fresh();
        const create = guild.createChannel.bind(guild);
        guild.createChannel = async (guildId, spec) => {
            const made = await create(guildId, spec);
            guild.snapshot = {
                ...guild.snapshot,
                channels: guild.snapshot.channels.map((c) =>
                    c.id === made ? { ...c, id: flake(NOW) } : c
                ),
            };
            throw new AddonTimeoutError('create channel', 30_000);
        };
        const first = await runArchive(guild, store);
        assert.equal(first.failed, 1);
        guild.createChannel = create;
        const second = await runArchive(guild, store);
        assert.equal(second.failed, 0);
        const categories = guild.snapshot.channels.filter((c) => c.type === 4);
        assert.deepEqual(
            categories.map((c) => c.id),
            [flake(NOW)]
        );
        const row = store.rows.find((r) => r.fluxerId === flake(NOW));
        assert.equal(row?.appliedFields?.[ARCHIVE_KEY], 1);
        assert.equal(row?.createdBySync, true);
        const moved = guild.snapshot.channels.find((c) => c.id === 'f1');
        assert.equal(moved?.parentId, flake(NOW));
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AddonMode } from '../../src/addons/config';
import {
    resolveMode,
    runCycle,
    type CycleDeps,
} from '../../src/guild-sync/cycle';
import type { ReadResult } from '../../src/guild-sync/health';
import { isRemoval } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import { createRecordingLogger } from '../addons/fakes';
import {
    DEFAULT_SETTINGS,
    FakeReader,
    FakeStore,
    recordingNotices,
} from './fake-store';
import {
    D_GUILD,
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    mapRow,
    role,
} from './fixtures';

const LINK = { id: 'link-1', discordGuildId: D_GUILD, fluxerGuildId: F_GUILD };
const NOW = new Date('2026-11-03T12:00:00Z');
const LONG_AGO = new Date('2026-10-01T00:00:00Z');

function channels(count: number) {
    return Array.from({ length: count }, (_, i) => channel(`c${i}`));
}

/**
 * A link where channel c0 is mapped, missing for weeks and confirmed gone
 * by lookup. Any healthy cycle would plan its removal.
 */
function primed(source: ReadResult, mode: AddonMode = 'dry-run') {
    const store = new FakeStore();
    store.rows = [
        mapRow('channel', 'c0', 'f0', {
            missingCount: 9,
            missingSince: LONG_AGO,
        }),
    ];
    const discord = new FakeReader(source, new Set(['c0']));
    const fluxer = new FakeReader({
        ok: true,
        snapshot: fluxerGuild({
            channels: [channel('f0', { name: 'channel-c0' })],
        }),
    });
    let seq = 0;
    const deps: CycleDeps = {
        store,
        readers: { discord, fluxer },
        writers: {},
        assets: {},
        links: null,
        threadSources: {},
        notices: recordingNotices().board,
        commandPrefix: '!b ',
        processMode: () => mode,
        allowApply: false,
        pause: async () => {},
        logger: createRecordingLogger(),
        now: () => NOW,
        newId: () => `plan-${++seq}`,
    };
    return { store, deps, discord };
}

const removals = (plan: Plan) =>
    [...plan.body.ops, ...plan.body.deferred].filter(isRemoval);

async function planFor(source: ReadResult, prime?: (store: FakeStore) => void) {
    const { store, deps } = primed(source);
    prime?.(store);
    const outcome = await runCycle(LINK, deps);
    assert.equal(outcome.status, 'planned');
    return { plan: (outcome as { plan: Plan }).plan, store };
}

describe('runCycle guard tests (required to merge)', () => {
    const healthy = discordGuild({ channels: channels(3).slice(1) });

    it('control: a healthy read with the object gone plans its archive', async () => {
        const { plan } = await planFor({ ok: true, snapshot: healthy });
        assert.equal(plan.status, 'dry-run');
        assert.deepEqual(
            removals(plan).map((o) => o.op),
            ['archive']
        );
    });

    const failing: [string, ReadResult, ((s: FakeStore) => void)?][] = [
        [
            'an empty source',
            { ok: true, snapshot: discordGuild({ roles: [], channels: [] }) },
        ],
        [
            'a partial source',
            { ok: true, snapshot: discordGuild({ roles: [] }) },
        ],
        ['a fetch error', { ok: false, reason: 'error', detail: '500' }],
        ['a timeout', { ok: false, reason: 'timeout', detail: 'slow' }],
        [
            'a 50% shrink',
            {
                ok: true,
                snapshot: discordGuild({ channels: channels(40).slice(20) }),
            },
            (store) =>
                store.snapshots.push({
                    snapshot: discordGuild({ channels: channels(40) }),
                    healthy: true,
                }),
        ],
    ];

    for (const [label, read, prime] of failing) {
        it(`plans zero archive or delete ops on ${label}`, async () => {
            const { plan, store } = await planFor(read, prime);
            // A shrink waits for an admin; every other failure is final.
            assert.equal(
                plan.status,
                plan.body.needsApproval ? 'pending-approval' : 'aborted'
            );
            assert.ok(plan.abortReason);
            assert.deepEqual(removals(plan), []);
            assert.deepEqual(plan.body.ops, []);
            // A failed read never advances the missing counters.
            assert.deepEqual(store.missingWrites, []);
        });
    }

    it('asks for approval after a shrink', async () => {
        const [, read, prime] = failing[4];
        const { plan } = await planFor(read, prime);
        assert.equal(plan.body.needsApproval, true);
    });
});

describe('runCycle modes', () => {
    const ok: ReadResult = { ok: true, snapshot: discordGuild() };

    it('skips the cycle when add-ons are read-only', async () => {
        const { deps, store, discord } = primed(ok, 'read-only');
        assert.equal((await runCycle(LINK, deps)).status, 'skipped');
        assert.equal(store.plans.length, 0);
        assert.equal(discord.lookups, 0);
    });

    it('skips the cycle when the kill switch is on', async () => {
        const { deps, store } = primed(ok);
        store.settings = { ...DEFAULT_SETTINGS, killSwitch: true };
        assert.equal((await runCycle(LINK, deps)).status, 'skipped');
    });

    it('applies only when the link and the environment both say so', () => {
        const apply = { ...DEFAULT_SETTINGS, mode: 'apply' as const };
        assert.equal(resolveMode('dry-run', apply).mode, 'dry-run');
        assert.equal(resolveMode('dry-run', apply, true).mode, 'apply');
        assert.equal(
            resolveMode('dry-run', DEFAULT_SETTINGS, true).mode,
            'dry-run'
        );
        assert.equal(resolveMode('read-only', apply, true).mode, 'read-only');
        assert.equal(
            resolveMode('dry-run', { ...apply, killSwitch: true }, true).mode,
            'read-only'
        );
    });

    it('does not save an unchanged snapshot twice', async () => {
        const { deps, store } = primed(ok);
        await runCycle(LINK, deps);
        await runCycle(LINK, deps);
        assert.equal(
            store.snapshots.filter((s) => s.snapshot.side === 'discord').length,
            1
        );
    });

    it('saves the plan and logs its summary', async () => {
        const { deps, store } = primed({
            ok: true,
            snapshot: discordGuild({ roles: [role(D_GUILD), role('r1')] }),
        });
        await runCycle(LINK, deps);
        assert.equal(store.plans.length, 1);
        const logger = deps.logger as ReturnType<typeof createRecordingLogger>;
        assert.ok(logger.entries.some((e) => /create role 1/.test(e.message)));
    });
});

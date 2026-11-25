import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCycle, type CycleDeps } from '../../src/guild-sync/cycle';
import { isRemoval, type MapRow, type PlanOp } from '../../src/guild-sync/ops';
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
    seededRandom,
} from './fixtures';

const RUNS = 200;
const LINK = { id: 'link', discordGuildId: D_GUILD, fluxerGuildId: F_GUILD };
const NOW = new Date('2026-11-03T12:00:00Z');
const LONG_AGO = new Date('2026-09-01T00:00:00Z');

interface World {
    readonly store: FakeStore;
    readonly deps: CycleDeps;
    readonly unmappedDest: Set<string>;
}

/** A random source, destination and map, with some rows ready to remove. */
function randomWorld(rand: () => number): World {
    const pick = (n: number) => Math.floor(rand() * n);
    const count = 1 + pick(15);
    const sourceChannels = [];
    const destChannels = [];
    const rows: MapRow[] = [];
    const gone = new Set<string>();
    for (let i = 0; i < count; i++) {
        const inSource = rand() < 0.6;
        const mapped = rand() < 0.7;
        if (inSource) sourceChannels.push(channel(`s${i}`));
        destChannels.push(channel(`d${i}`, { name: `channel-s${i}` }));
        if (!mapped) continue;
        const ready = !inSource && rand() < 0.8;
        rows.push(
            mapRow('channel', `s${i}`, `d${i}`, {
                state: rand() < 0.3 ? 'archived' : 'active',
                createdBySync: rand() < 0.7,
                missingCount: ready ? 3 + pick(5) : 0,
                missingSince: ready ? LONG_AGO : null,
            })
        );
        if (rand() < 0.8) gone.add(`s${i}`);
    }
    const extraDest = Array.from({ length: pick(5) }, (_, i) =>
        channel(`x${i}`)
    );
    const store = new FakeStore();
    store.rows = rows;
    store.settings = { ...DEFAULT_SETTINGS, deleteBudgetPerCycle: pick(4) };
    const source = discordGuild({
        roles: [role(D_GUILD)],
        channels:
            sourceChannels.length > 0 ? sourceChannels : [channel('only')],
    });
    const deps: CycleDeps = {
        store,
        readers: {
            discord: new FakeReader({ ok: true, snapshot: source }, gone),
            fluxer: new FakeReader({
                ok: true,
                snapshot: fluxerGuild({
                    channels: [...destChannels, ...extraDest],
                }),
            }),
        },
        writers: {},
        assets: {},
        links: null,
        threadSources: {},
        notices: recordingNotices().board,
        commandPrefix: '!b ',
        processMode: () => 'dry-run',
        allowApply: false,
        pause: async () => {},
        logger: createRecordingLogger(),
        now: () => NOW,
        newId: () => 'plan',
    };
    const mappedDest = new Set(rows.map((r) => r.fluxerId));
    const unmappedDest = new Set(
        [...destChannels, ...extraDest]
            .map((c) => c.id)
            .filter((id) => !mappedDest.has(id))
    );
    return { store, deps, unmappedDest };
}

function touched(op: PlanOp): string[] {
    if (op.op === 'create') return [];
    if (op.op === 'reorder') return [...op.destIds];
    return [op.destId];
}

async function planOf(world: World): Promise<Plan> {
    const outcome = await runCycle(LINK, world.deps);
    assert.equal(outcome.status, 'planned');
    return (outcome as { plan: Plan }).plan;
}

describe('guild-sync properties', () => {
    it('never plans more removals than the budget without approval', async () => {
        const rand = seededRandom(20261103);
        for (let run = 0; run < RUNS; run++) {
            const world = randomWorld(rand);
            const plan = await planOf(world);
            const removals = plan.body.ops.filter(isRemoval).length;
            if (!plan.body.needsApproval) {
                assert.ok(
                    removals <= world.store.settings.deleteBudgetPerCycle,
                    `run ${run}: ${removals} removals without approval`
                );
            }
        }
    });

    it('never puts an unmapped destination object in a plan', async () => {
        const rand = seededRandom(7);
        for (let run = 0; run < RUNS; run++) {
            const world = randomWorld(rand);
            const plan = await planOf(world);
            for (const op of [...plan.body.ops, ...plan.body.deferred]) {
                for (const id of touched(op)) {
                    assert.ok(
                        !world.unmappedDest.has(id),
                        `run ${run}: ${op.op} on ${id}`
                    );
                }
            }
        }
    });
});

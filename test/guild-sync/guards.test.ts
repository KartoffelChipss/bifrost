import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    applyMissing,
    checkDeleteBudget,
    enforceOwnership,
    orderAndCap,
    planRemovals,
    removalCandidates,
    trackMissing,
    type GuardSettings,
} from '../../src/guild-sync/guards';
import { IdMap } from '../../src/guild-sync/idmap';
import type { PlanOp } from '../../src/guild-sync/ops';
import { D_GUILD, F_GUILD, channel, discordGuild, mapRow } from './fixtures';

const SETTINGS: GuardSettings = {
    confirmChecks: 3,
    confirmMinutes: 30,
    gracePeriodDays: 14,
    deleteBudgetPerCycle: 3,
    deleteBudgetPerDay: 10,
    writeCapPerCycle: 50,
};
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = new Date('2026-11-01T00:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const archive = (destId: string): PlanOp => ({
    op: 'archive',
    kind: 'channel',
    sourceId: `s-${destId}`,
    destId,
});

describe('trackMissing and removalCandidates (guard 4)', () => {
    it('needs N checks over T minutes before a row is a candidate', () => {
        const source = discordGuild({ channels: [channel('keep')] });
        let rows = [mapRow('channel', 'gone', 'f-gone')];
        const times = [0, 10 * MIN, 20 * MIN, 31 * MIN];
        const counts: number[] = [];
        for (const ms of times) {
            rows = applyMissing(
                rows,
                trackMissing(rows, source, 'discord-to-fluxer', at(ms))
            );
            counts.push(removalCandidates(rows, SETTINGS, at(ms)).length);
        }
        // Third check is too soon (20 min); the fourth passes both limits.
        assert.deepEqual(counts, [0, 0, 0, 1]);
    });

    it('protects threads only under a parent whose thread list has a gap', () => {
        const source = discordGuild({
            channels: [channel('a'), channel('b')],
            threadGaps: ['a'],
        });
        const thread = (id: string, parentId: unknown) =>
            mapRow('thread', id, `f-${id}`, {
                appliedFields:
                    parentId === undefined
                        ? {}
                        : { parentId: parentId as string },
            });
        const rows = [
            mapRow('channel', 'a', 'f-a'),
            mapRow('channel', 'b', 'f-b'),
            thread('in-gap', 'f-a'),
            thread('elsewhere', 'f-b'),
            thread('unknown', undefined),
            thread('unmapped-parent', 'f-zzz'),
        ];
        const missing = trackMissing(rows, source, 'discord-to-fluxer', T0);
        const counted = rows
            .filter((r) => missing.some((m) => m.rowId === r.id))
            .map((r) => r.discordId);
        assert.deepEqual(counted, ['elsewhere']);
    });

    it('resets the counter when the object comes back', () => {
        const row = mapRow('channel', 'c1', 'f1', {
            missingCount: 2,
            missingSince: T0,
        });
        const updates = trackMissing(
            [row],
            discordGuild({ channels: [channel('c1')] }),
            'discord-to-fluxer',
            at(MIN)
        );
        assert.deepEqual(updates, [
            { rowId: row.id, missingCount: 0, missingSince: null },
        ]);
    });
});

describe('planRemovals (guards 4 to 6)', () => {
    const ready = { missingCount: 3, missingSince: T0 };

    it('defers a candidate the direct lookup did not confirm', () => {
        const row = mapRow('channel', 'c1', 'f1', ready);
        const result = planRemovals(
            [row],
            new Set(),
            'discord-to-fluxer',
            SETTINGS,
            at(DAY)
        );
        assert.deepEqual(result.ops, []);
        assert.equal(result.findings[0]?.type, 'removal-deferred');
    });

    it('archives first and hard-deletes only after the grace period', () => {
        const active = mapRow('channel', 'c1', 'f1', ready);
        const archived = mapRow('channel', 'c2', 'f2', {
            ...ready,
            state: 'archived',
        });
        const gone = new Set([active.id, archived.id]);
        const early = planRemovals(
            [active, archived],
            gone,
            'discord-to-fluxer',
            SETTINGS,
            at(13 * DAY)
        );
        assert.deepEqual(
            early.ops.map((o) => o.op),
            ['archive']
        );
        const late = planRemovals(
            [archived],
            gone,
            'discord-to-fluxer',
            SETTINGS,
            at(14 * DAY)
        );
        assert.deepEqual(late.ops, [
            {
                op: 'hard-delete',
                kind: 'channel',
                sourceId: 'c2',
                destId: 'f2',
                adopted: false,
            },
        ]);
    });
});

describe('enforceOwnership (guard 1)', () => {
    const map = new IdMap(
        [mapRow('channel', 'c1', 'f1')],
        'discord-to-fluxer',
        D_GUILD,
        F_GUILD
    );

    it('drops ops on unmapped or protected destination objects', () => {
        const ops: PlanOp[] = [
            archive('f1'),
            archive('stray'),
            { op: 'archive', kind: 'role', sourceId: D_GUILD, destId: F_GUILD },
            {
                op: 'update',
                kind: 'channel',
                sourceId: 'x',
                destId: 'stray',
                changes: [],
            },
            {
                op: 'reorder',
                kind: 'channel',
                scope: 'top',
                destIds: ['f1', 'stray'],
            },
        ];
        const { kept, dropped } = enforceOwnership(
            ops,
            map,
            new Set([F_GUILD])
        );
        assert.deepEqual(kept, [archive('f1')]);
        assert.equal(dropped.length, 4);
    });

    it('lets @everyone be updated but never removed', () => {
        const update: PlanOp = {
            op: 'update',
            kind: 'role',
            sourceId: D_GUILD,
            destId: F_GUILD,
            changes: [],
        };
        assert.deepEqual(enforceOwnership([update], map, new Set()).kept, [
            update,
        ]);
    });
});

describe('checkDeleteBudget (guard 7)', () => {
    it('asks for approval over the cycle or daily budget', () => {
        const three = ['a', 'b', 'c'].map(archive);
        assert.equal(
            checkDeleteBudget(three, SETTINGS, 0).needsApproval,
            false
        );
        assert.equal(
            checkDeleteBudget([...three, archive('d')], SETTINGS, 0)
                .needsApproval,
            true
        );
        assert.equal(checkDeleteBudget(three, SETTINGS, 8).needsApproval, true);
    });

    it('asks for approval to hard-delete an adopted object', () => {
        const op: PlanOp = {
            op: 'hard-delete',
            kind: 'role',
            sourceId: 's',
            destId: 'd',
            adopted: true,
        };
        assert.equal(checkDeleteBudget([op], SETTINGS, 0).needsApproval, true);
    });
});

describe('orderAndCap (guard 14)', () => {
    it('puts removals last and defers what is over the cap', () => {
        const create = (kind: 'role' | 'channel', id: string): PlanOp => ({
            op: 'create',
            kind,
            sourceId: id,
            name: id,
            existingDestId: null,
        });
        const ops = [archive('x'), create('channel', 'c'), create('role', 'r')];
        const { now, deferred } = orderAndCap(ops, 2);
        assert.deepEqual(
            now.map((o) => o.kind),
            ['role', 'channel']
        );
        assert.deepEqual(deferred, [archive('x')]);
    });

    it('defers everything on an invalid cap', () => {
        assert.equal(orderAndCap([archive('x')], 0).now.length, 0);
    });
});

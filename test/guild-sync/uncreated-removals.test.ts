import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isApproved } from '../../src/guild-sync/cycle';
import {
    checkDeleteBudget,
    planRemovals,
    type GuardSettings,
} from '../../src/guild-sync/guards';
import type { MapRow } from '../../src/guild-sync/ops';
import { EMPTY_BODY, type Plan } from '../../src/guild-sync/plan';
import { D_GUILD, F_GUILD, discordGuild, mapRow, role } from './fixtures';
import { NOW, setup } from './harness';

const GUARDS: GuardSettings = {
    confirmChecks: 3,
    confirmMinutes: 30,
    gracePeriodDays: 14,
    deleteBudgetPerCycle: 3,
    deleteBudgetPerDay: 10,
    writeCapPerCycle: 50,
};

/** A confirmed-gone thread row, by default one sync created. */
const gone = (id: string, createdBySync = true): MapRow =>
    mapRow('thread', id, `f${id}`, { createdBySync });

const removals = (rows: MapRow[]) =>
    planRemovals(
        rows,
        new Set(rows.map((r) => r.id)),
        'discord-to-fluxer',
        GUARDS,
        NOW
    ).ops;

/** A plan of the rows' removals, waiting for approval. */
function pendingPlan(rows: MapRow[], removalsToday = 0): Plan {
    const ops = removals(rows);
    const budget = checkDeleteBudget(ops, GUARDS, removalsToday);
    assert.ok(budget.needsApproval);
    return {
        id: 'p1',
        guildLinkId: 'link-1',
        direction: 'discord-to-fluxer',
        status: 'pending-approval',
        body: {
            ...EMPTY_BODY,
            ops,
            needsApproval: true,
            approvalReason: budget.reason,
        },
        abortReason: null,
    };
}

describe('removals of objects sync did not create', () => {
    it('needs approval to archive an object sync did not create', () => {
        const ops = removals([gone('mirrored', false)]);
        assert.ok(ops[0].op === 'archive' && ops[0].adopted === true);
        const budget = checkDeleteBudget(ops, GUARDS, 0);
        assert.ok(budget.needsApproval);
        assert.match(budget.reason, /did not create/);
        const own = checkDeleteBudget(removals([gone('own')]), GUARDS, 0);
        assert.equal(own.needsApproval, false);
    });

    it('never covers them with an approval given for the budget alone', () => {
        const ids = ['a', 'b', 'c', 'd'];
        const approved = pendingPlan(ids.map((id) => gone(id)));
        const next = pendingPlan(ids.map((id) => gone(id, id !== 'b')));
        assert.equal(isApproved(next, approved), false);
        assert.equal(isApproved(next, next), true);
    });

    it('keeps an approval when one of its causes drops off', () => {
        // Over the cycle and daily budgets; then the day slides past.
        const rows = ['a', 'b', 'c', 'd'].map((id) => gone(id));
        const approved = pendingPlan(rows, 8);
        assert.match(approved.body.approvalReason ?? '', /cycle budget.*daily/);
        const next = pendingPlan(rows, 0);
        assert.doesNotMatch(next.body.approvalReason ?? '', /daily/);
        assert.equal(isApproved(next, approved), true);
    });

    it('voids an approval when a new cause appears', () => {
        const rows = ['a', 'b', 'c', 'd'].map((id) => gone(id));
        const approved = pendingPlan(rows, 0);
        const next = pendingPlan(rows, 8);
        assert.match(next.body.approvalReason ?? '', /daily/);
        assert.equal(isApproved(next, approved), false);
    });

    it('holds the archive of a mirrored pair for approval in a cycle', async () => {
        const s = setup(
            discordGuild({
                roles: [role(D_GUILD), role('r1', { name: 'Mods' })],
            })
        );
        await s.cycle();
        s.store.rows = s.store.rows.map((r) =>
            r.kind === 'role' ? { ...r, createdBySync: false } : r
        );
        s.discord.result = {
            ok: true,
            snapshot: discordGuild({ roles: [role(D_GUILD)] }),
        };
        s.discord.gone = new Set(['r1']);
        for (let i = 0; i < 3; i++) {
            await s.cycle();
            s.wait(20);
        }
        const held = await s.cycle();
        assert.equal(held.plan.status, 'pending-approval');
        assert.ok(held.plan.body.ops.some((op) => op.op === 'archive'));
        const mods = s.guild.snapshot.roles.find((r) => r.id !== F_GUILD);
        assert.equal(mods?.name, 'Mods');
    });
});

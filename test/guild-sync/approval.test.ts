import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    MAX_LOOKUPS_PER_CYCLE,
    reasonCategory,
} from '../../src/guild-sync/cycle';
import { isRemoval } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import { D_GUILD, channel, discordGuild, role } from './fixtures';
import { LINK, setup } from './harness';

const names = Array.from({ length: 25 }, (_, i) => `r${i}`);

const removalIds = (plan: Plan) =>
    [...plan.body.ops, ...plan.body.deferred]
        .filter(isRemoval)
        .map((op) => ('destId' in op ? op.destId : ''))
        .sort();

/** 25 synced roles, then all of them gone from Discord and confirmed. */
async function manyGone() {
    const s = setup(
        discordGuild({
            roles: [role(D_GUILD), ...names.map((n) => role(n, { name: n }))],
        })
    );
    s.store.settings = {
        ...s.store.settings,
        adminChannelId: 'admin',
        shrinkPercent: 100,
    };
    await s.cycle();
    s.discord.result = {
        ok: true,
        snapshot: discordGuild({ roles: [role(D_GUILD)] }),
    };
    s.discord.gone = new Set(names);
    await s.cycle();
    s.wait(20);
    await s.cycle();
    s.wait(20);
    return s;
}

describe('approval of a large removal batch', () => {
    it('keeps the same batch while it waits, and runs it once approved', async () => {
        const s = await manyGone();
        const first = await s.cycle();
        assert.equal(first.plan.status, 'pending-approval');
        assert.equal(removalIds(first.plan).length, MAX_LOOKUPS_PER_CYCLE);
        const second = await s.cycle();
        assert.deepEqual(removalIds(second.plan), removalIds(first.plan));

        await s.store.setApprovedPlan(LINK.id, first.plan.id);
        const third = await s.cycle();
        assert.equal(third.applied?.applied, MAX_LOOKUPS_PER_CYCLE);
    });

    it('applies creates and updates while removals wait', async () => {
        const s = await manyGone();
        s.discord.result = {
            ok: true,
            snapshot: discordGuild({
                roles: [role(D_GUILD)],
                channels: [
                    channel('101'),
                    channel('new', { name: 'new-channel' }),
                ],
            }),
        };
        const held = await s.cycle();
        assert.equal(held.plan.status, 'pending-approval');
        assert.ok(
            s.guild.snapshot.channels.some((c) => c.name === 'new-channel')
        );
        assert.ok(
            !s.guild.snapshot.roles.some((r) => r.name.startsWith('[archived]'))
        );
        const stored = await s.store.getPlan(held.plan.id);
        assert.equal(stored?.status, 'pending-approval');
    });
});

describe('approval reason', () => {
    it('ignores the counts, which slide with every removal', () => {
        assert.equal(
            reasonCategory('12 removals today, over the daily budget of 10'),
            reasonCategory('14 removals today, over the daily budget of 10')
        );
        assert.notEqual(
            reasonCategory('hard delete of an adopted object'),
            reasonCategory('4 removals, over the cycle budget of 3')
        );
    });
});

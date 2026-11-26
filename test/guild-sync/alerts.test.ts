import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setup } from './harness';
import { D_GUILD, channel, discordGuild, role } from './fixtures';

/**
 * Which cycles post a message to the admin channel. Routine plans and
 * clean applies only update the status message; approval requests, aborts
 * and failed applies are posted, each once per distinct content.
 */

const roles = (...names: string[]) =>
    discordGuild({
        roles: [role(D_GUILD), ...names.map((n) => role(n, { name: n }))],
    });

function withAdmin(s: ReturnType<typeof setup>) {
    s.store.settings = { ...s.store.settings, adminChannelId: 'admin' };
    return s;
}

describe('admin channel alerts', () => {
    it('posts nothing for routine plans and clean applies', async () => {
        const s = withAdmin(setup(roles('a', 'b')));
        const first = await s.cycle();
        assert.ok((first.applied?.applied ?? 0) > 0);
        assert.equal(first.applied?.failed, 0);
        await s.cycle();
        assert.deepEqual(s.posted, []);
    });

    it('posts nothing per batch while a long first copy runs', async () => {
        const s = withAdmin(setup(roles('a', 'b', 'c', 'd')));
        s.store.settings = { ...s.store.settings, writeCapPerCycle: 1 };
        for (let i = 0; i < 4; i++) {
            const { plan } = await s.cycle();
            assert.ok(plan.body.ops.length > 0);
        }
        assert.deepEqual(s.posted, []);
    });

    it('reports the same failing write once, not every cycle', async () => {
        const s = withAdmin(setup(roles('a')));
        s.guild.failCreates.add('a');
        for (let i = 0; i < 3; i++) {
            const { applied } = await s.cycle();
            assert.equal(applied?.failed, 1);
        }
        assert.equal(s.posted.length, 1);
        assert.equal(s.posted[0].channelId, 'admin');
        assert.match(s.posted[0].text, /create role a failed: create refused/);
    });

    it('reports a new set of failures again', async () => {
        const s = withAdmin(setup(roles('a')));
        s.guild.failCreates.add('a');
        await s.cycle();
        s.discord.result = { ok: true, snapshot: roles('a', 'b') };
        s.guild.failCreates.add('b');
        await s.cycle();
        assert.equal(s.posted.length, 2);
        assert.match(s.posted[1].text, /create role b failed/);
    });

    it('reports an aborted plan once while it stays the same', async () => {
        const s = withAdmin(setup(roles('a')));
        s.discord.result = { ok: false, reason: 'error', detail: '503' };
        await s.cycle();
        await s.cycle();
        assert.equal(s.posted.length, 1);
        assert.match(s.posted[0].text, /Aborted: .*503/);
    });

    it('does not repost an approval request and a failure that alternate', async () => {
        const many = Array.from({ length: 4 }, (_, i) => `r${i}`);
        const s = withAdmin(setup(roles(...many)));
        await s.cycle();
        // Four roles gone at once, over the cycle budget of three, and a
        // new role whose create keeps failing.
        s.store.settings = { ...s.store.settings, shrinkPercent: 100 };
        s.discord.result = { ok: true, snapshot: roles('x') };
        s.discord.gone = new Set(many);
        s.guild.failCreates.add('x');
        for (let i = 0; i < 6; i++) {
            await s.cycle();
            s.wait(20);
        }
        const last = await s.cycle();
        assert.equal(last.plan.status, 'pending-approval');
        assert.equal(last.applied?.failed, 1);
        const failures = s.posted.filter((n) => /create role x/.test(n.text));
        assert.equal(failures.length, 1);
        assert.ok(s.posted.some((n) => /sync approve/.test(n.text)));
        // Once the request is settled, neither alert is posted again.
        const before = s.posted.length;
        for (let i = 0; i < 3; i++) {
            const next = await s.cycle();
            assert.equal(next.plan.status, 'pending-approval');
        }
        assert.equal(s.posted.length, before);
    });

    it('still posts the approval commands for a held shrink', async () => {
        const many = Array.from({ length: 20 }, (_, i) => channel(`c${i}`));
        const s = withAdmin(setup(discordGuild({ channels: many })));
        await s.cycle();
        s.discord.result = {
            ok: true,
            snapshot: discordGuild({ channels: many.slice(0, 5) }),
        };
        const { plan } = await s.cycle();
        assert.equal(plan.status, 'pending-approval');
        assert.equal(s.posted.length, 1);
        assert.match(s.posted[0].text, /shrink check/);
        assert.match(s.posted[0].text, new RegExp(`sync approve ${plan.id}`));
    });
});

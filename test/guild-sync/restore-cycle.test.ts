import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCycle } from '../../src/guild-sync/cycle';
import type { MapRow } from '../../src/guild-sync/ops';
import { summarizePlan, type Plan } from '../../src/guild-sync/plan';
import {
    MAX_RESTORES_PER_CYCLE,
    MAX_RESTORES_PER_DAY,
} from '../../src/guild-sync/restore';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import { RESTORE_OP } from '../../src/guild-sync/store';
import { freshJob } from './fake-store';
import { channel, discordGuild, role } from './fixtures';
import { LINK, NOW, setup } from './harness';

type Setup = ReturnType<typeof setup>;

const post = (id: string, name: string, parentId = 'forum') => ({
    id,
    parentId,
    name,
    archived: false,
    locked: false,
    tags: [],
});

// A second channel keeps the Fluxer server plausible when the forum goes:
// a destination without channels never counts anything as missing.
const forum = () =>
    discordGuild({
        channels: [
            channel('forum', { type: 15, name: 'game-chat' }),
            channel('101', { position: 1 }),
        ],
        threads: [post('post1', 'First'), post('post2', 'Second')],
    });

/** Syncs `source` in apply mode until nothing is left to write. */
async function synced(source: GuildSnapshot, links = false): Promise<Setup> {
    const s = setup(source);
    if (links) s.useLinks();
    s.store.settings = { ...s.store.settings, adminChannelId: 'admin' };
    for (let i = 0; i < 5; i++) {
        await s.cycle();
        s.wait(1);
    }
    s.guild.lookup = s.guild.goneFromSnapshot;
    return s;
}

const rowOf = (s: Setup, kind: MapRow['kind'], discordId: string) =>
    s.store.rows.find((r) => r.kind === kind && r.discordId === discordId);

function fluxerIdOf(s: Setup, kind: MapRow['kind'], discordId: string) {
    const id = rowOf(s, kind, discordId)?.fluxerId;
    assert.ok(id, `${kind} ${discordId} is mapped`);
    return id;
}

/**
 * Runs the three cycles that only count a missing copy (20 minutes, under
 * confirmMinutes), then the one past both thresholds.
 */
async function untilConfirmed(s: Setup): Promise<{ before: Plan; plan: Plan }> {
    await s.cycle();
    s.wait(10);
    await s.cycle();
    s.wait(10);
    const before = (await s.cycle()).plan;
    s.wait(15);
    return { before, plan: (await s.cycle()).plan };
}

const restoredIds = (plan: Plan) =>
    (plan.body.restores ?? []).map((r) => `${r.kind}:${r.discordId}`);

describe('restoring a thread deleted on Fluxer', () => {
    it('waits for the thresholds, then forgets the row and the next cycle recreates it', async () => {
        const s = await synced(forum(), true);
        const oldId = fluxerIdOf(s, 'thread', 'post1');
        s.guild.removeByHand(oldId);

        const { before, plan } = await untilConfirmed(s);

        assert.deepEqual(restoredIds(before), []);
        assert.deepEqual(restoredIds(plan), ['thread:post1']);
        assert.equal(rowOf(s, 'thread', 'post1'), undefined);
        assert.ok(
            plan.body.findings.some(
                (f) => f.type === 'restore' && f.id === oldId
            )
        );
        assert.equal(
            plan.body.findings.some(
                (f) => f.type === 'missing-on-destination' && f.id === oldId
            ),
            false
        );
        assert.match(
            summarizePlan(plan),
            /restore thread "First" \(.+\): deleted on Fluxer, will be recreated/
        );
        const audit = s.store.audits.find((a) => a.op === RESTORE_OP);
        assert.equal(audit?.destId, oldId);
        assert.equal(audit?.result, 'ok');

        s.wait(1);
        await s.cycle();
        const newId = fluxerIdOf(s, 'thread', 'post1');
        assert.notEqual(newId, oldId);
        assert.ok(s.guild.snapshot.threads.some((t) => t.id === newId));
        assert.equal(rowOf(s, 'thread', 'post1')?.createdBySync, true);
    });

    it('clears the relayed pairs, parked replies and imported history', async () => {
        const s = await synced(forum(), true);
        const oldId = fluxerIdOf(s, 'thread', 'post1');
        s.store.threadMessages = [
            {
                guildLinkId: LINK.id,
                discordThreadId: 'post1',
                fluxerThreadId: oldId,
                discordMessageId: 'dm1',
                fluxerMessageId: 'fm1',
            },
        ];
        s.store.parked = [
            { side: 'discord', threadId: 'post1', messageId: 'p1' },
        ];
        s.store.historyJobs = [
            freshJob('job-1', 'post1', { status: 'done', fluxerId: oldId }),
            freshJob('job-2', 'post2', { status: 'done' }),
        ];
        s.store.historyMessages = [
            { discordMessageId: 'h1', jobId: 'job-1' },
            { discordMessageId: 'h2', jobId: 'job-2' },
        ];
        s.guild.removeByHand(oldId);

        await untilConfirmed(s);

        assert.deepEqual(s.store.threadMessages, []);
        assert.deepEqual(s.store.parked, []);
        assert.deepEqual(s.store.historyMessages, [
            { discordMessageId: 'h2', jobId: 'job-2' },
        ]);
        assert.equal(s.store.historyJobs[0].status, 'pending');
        assert.equal(s.store.historyJobs[0].fluxerId, null);
        assert.equal(s.store.historyJobs[1].status, 'done');
    });

    it('does nothing while the lookup does not confirm the copy is gone', async () => {
        for (const answer of [false, null]) {
            const s = await synced(forum(), true);
            const oldId = fluxerIdOf(s, 'thread', 'post1');
            s.guild.removeByHand(oldId);
            s.guild.lookup = () => answer;

            const { plan } = await untilConfirmed(s);

            assert.deepEqual(restoredIds(plan), []);
            assert.deepEqual(s.store.restored, []);
            assert.equal(rowOf(s, 'thread', 'post1')?.fluxerId, oldId);
            assert.ok(
                plan.body.findings.some(
                    (f) =>
                        f.type === 'restore-held' &&
                        f.id === oldId &&
                        f.detail.includes('did not confirm')
                )
            );
        }
    });

    it('leaves rows recorded from Fluxer and adopted objects as findings', async () => {
        const s = await synced(forum(), true);
        const oldId = fluxerIdOf(s, 'thread', 'post1');
        s.store.rows = s.store.rows.map((r) =>
            r.discordId === 'post1' ? { ...r, createdBySync: false } : r
        );
        s.guild.removeByHand(oldId);

        const { plan } = await untilConfirmed(s);
        s.wait(60);
        const later = (await s.cycle()).plan;

        assert.deepEqual(s.store.restored, []);
        assert.equal(rowOf(s, 'thread', 'post1')?.fluxerId, oldId);
        for (const p of [plan, later]) {
            assert.deepEqual(restoredIds(p), []);
            assert.ok(
                p.body.findings.some(
                    (f) => f.type === 'missing-on-destination' && f.id === oldId
                )
            );
        }
        assert.equal(s.guild.lookups.includes(`thread:${oldId}`), false);
    });
});

describe('restore modes and switches', () => {
    it('only reports in dry-run', async () => {
        const s = await synced(forum(), true);
        const oldId = fluxerIdOf(s, 'thread', 'post1');
        s.store.settings = { ...s.store.settings, mode: 'dry-run' };
        s.guild.removeByHand(oldId);

        const { plan } = await untilConfirmed(s);

        assert.deepEqual(restoredIds(plan), ['thread:post1']);
        assert.deepEqual(s.store.restored, []);
        assert.equal(rowOf(s, 'thread', 'post1')?.fluxerId, oldId);
    });

    it('does nothing with the kill switch on or the add-ons read-only', async () => {
        const s = await synced(forum(), true);
        const oldId = fluxerIdOf(s, 'thread', 'post1');
        s.guild.removeByHand(oldId);
        await untilConfirmed(s);
        // Restored already; take the next deleted copy through the switches.
        const second = fluxerIdOf(s, 'thread', 'post2');
        s.guild.removeByHand(second);
        const writes = s.store.destMissingWrites.length;
        s.store.settings = { ...s.store.settings, killSwitch: true };
        for (let i = 0; i < 4; i++) {
            s.wait(15);
            const outcome = await runCycle(LINK, s.depsFor());
            assert.equal(outcome.status, 'skipped');
        }
        s.store.settings = { ...s.store.settings, killSwitch: false };
        s.state.processMode = 'read-only';
        const outcome = await runCycle(LINK, s.depsFor());
        assert.equal(outcome.status, 'skipped');
        assert.equal(s.store.destMissingWrites.length, writes);
        assert.equal(rowOf(s, 'thread', 'post2')?.fluxerId, second);
        assert.equal(s.store.restored.length, 1);
    });

    it('stops when the kill switch flips after the plan was saved', async () => {
        const s = await synced(forum(), true);
        const oldId = fluxerIdOf(s, 'thread', 'post1');
        s.guild.removeByHand(oldId);
        const save = s.store.savePlan.bind(s.store);
        s.store.savePlan = async (plan: Plan) => {
            await save(plan);
            if ((plan.body.restores ?? []).length === 0) return;
            s.store.settings = { ...s.store.settings, killSwitch: true };
        };

        const { plan } = await untilConfirmed(s);

        assert.deepEqual(restoredIds(plan), ['thread:post1']);
        assert.deepEqual(s.store.restored, []);
        assert.equal(rowOf(s, 'thread', 'post1')?.fluxerId, oldId);
    });
});

/** A server with `n` roles, r0 to r(n-1). */
const withRoles = (n: number) =>
    discordGuild({
        roles: [
            role(discordGuild().guildId, { name: '@everyone', position: 0 }),
            ...Array.from({ length: n }, (_, i) =>
                role(`r${i}`, { position: i + 1 })
            ),
        ],
    });

function deleteRoles(s: Setup, ids: readonly string[]) {
    s.guild.removeByHand(...ids.map((id) => fluxerIdOf(s, 'role', id)));
}

describe('restore guards', () => {
    it('holds every restore when many copies go missing at once, until an admin approves', async () => {
        const s = await synced(withRoles(8));
        const gone = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'];
        deleteRoles(s, gone);

        const { plan } = await untilConfirmed(s);
        s.wait(5);
        const again = (await s.cycle()).plan;

        assert.deepEqual(s.store.restored, []);
        for (const p of [plan, again]) {
            assert.equal(p.status, 'pending-approval');
            assert.match(
                p.body.restoreHold ?? '',
                /6 of 9 role copies are missing on Fluxer at once/
            );
            assert.match(p.body.approvalReason ?? '', /missing on Fluxer/);
        }
        assert.equal(restoredIds(again).length, 6);
        const alert = s.posted.find((n) => n.text.includes('Restores held'));
        assert.equal(alert?.channelId, 'admin');
        assert.match(alert?.text ?? '', /sync approve/);

        await s.store.setApprovedPlan(LINK.id, again.id);
        s.wait(5);
        await s.cycle();
        assert.equal(s.store.restored.length, 6);
        s.wait(1);
        await s.cycle();
        for (const id of gone) {
            const fluxerId = fluxerIdOf(s, 'role', id);
            assert.ok(s.guild.snapshot.roles.some((r) => r.id === fluxerId));
        }
    });

    it(`restores at most ${MAX_RESTORES_PER_CYCLE} copies a cycle`, async () => {
        const s = await synced(withRoles(12));
        s.store.settings = { ...s.store.settings, shrinkMinObjects: 100 };
        const gone = Array.from({ length: 12 }, (_, i) => `r${i}`);
        deleteRoles(s, gone);

        const { plan } = await untilConfirmed(s);

        assert.equal(restoredIds(plan).length, MAX_RESTORES_PER_CYCLE);
        assert.equal(s.store.restored.length, MAX_RESTORES_PER_CYCLE);
        assert.ok(
            plan.body.findings.some(
                (f) =>
                    f.type === 'restore-held' &&
                    f.detail.startsWith('2 more copies deleted on Fluxer wait')
            )
        );
        s.wait(1);
        const next = (await s.cycle()).plan;
        assert.equal(restoredIds(next).length, 2);
        assert.equal(s.store.restored.length, 12);
    });

    it(`restores at most ${MAX_RESTORES_PER_DAY} copies a day`, async () => {
        for (const [today, expected] of [
            [MAX_RESTORES_PER_DAY - 2, 2],
            [MAX_RESTORES_PER_DAY, 0],
        ] as const) {
            const s = await synced(withRoles(3));
            for (let i = 0; i < today; i++) {
                await s.store.audit(
                    {
                        planId: 'earlier',
                        guildLinkId: LINK.id,
                        op: RESTORE_OP,
                        kind: 'emoji',
                        sourceId: `e${i}`,
                        destId: `f-e${i}`,
                        before: null,
                        after: null,
                        result: 'ok',
                    },
                    s.state.now
                );
            }
            deleteRoles(s, ['r0', 'r1', 'r2']);

            const { plan } = await untilConfirmed(s);

            assert.equal(restoredIds(plan).length, expected);
            assert.equal(s.store.restored.length, expected);
            if (expected === 0) {
                assert.ok(
                    plan.body.findings.some(
                        (f) =>
                            f.type === 'restore-held' &&
                            f.detail.includes('daily cap')
                    )
                );
            }
        }
    });
});

describe('restoring each kind', () => {
    it('unlinks a channel, resets its history and forgets its threads', async () => {
        const s = await synced(forum(), true);
        const oldForum = fluxerIdOf(s, 'channel', 'forum');
        const oldPosts = ['post1', 'post2'].map((id) =>
            fluxerIdOf(s, 'thread', id)
        );
        const forumLink = () =>
            s.linker.links.find((l) => l.discordChannelId === 'forum');
        assert.equal(forumLink()?.fluxerChannelId, oldForum);
        s.store.historyJobs = [
            freshJob('job-c', 'forum', {
                kind: 'channel',
                status: 'done',
                fluxerId: oldForum,
            }),
        ];
        s.store.historyMessages = [{ discordMessageId: 'h1', jobId: 'job-c' }];
        s.guild.removeByHand(oldForum);

        const { plan } = await untilConfirmed(s);

        assert.deepEqual(restoredIds(plan), ['channel:forum']);
        assert.deepEqual(s.linker.unlinked, ['forum']);
        assert.deepEqual(
            s.store.restored[0].threads.map((t) => t.fluxerId).sort(),
            [...oldPosts].sort()
        );
        assert.equal(rowOf(s, 'channel', 'forum'), undefined);
        assert.equal(rowOf(s, 'thread', 'post1'), undefined);
        assert.equal(rowOf(s, 'thread', 'post2'), undefined);
        assert.equal(s.store.historyJobs[0].status, 'pending');
        assert.equal(s.store.historyJobs[0].fluxerId, null);
        assert.deepEqual(s.store.historyMessages, []);

        for (let i = 0; i < 4; i++) {
            s.wait(1);
            await s.cycle();
        }
        const newForum = fluxerIdOf(s, 'channel', 'forum');
        assert.notEqual(newForum, oldForum);
        assert.equal(forumLink()?.fluxerChannelId, newForum);
        const threads = s.guild.snapshot.threads;
        assert.deepEqual(
            threads.map((t) => t.parentId),
            [newForum, newForum]
        );
    });

    it('recreates a category and moves its channel back in', async () => {
        const s = await synced(
            discordGuild({
                channels: [
                    channel('cat', { type: 4, name: 'Category' }),
                    channel('c1', { parentId: 'cat', position: 1 }),
                ],
            })
        );
        const oldCat = fluxerIdOf(s, 'category', 'cat');
        const c1 = fluxerIdOf(s, 'channel', 'c1');
        s.guild.removeByHand(oldCat);
        const top = s.guild.snapshot.channels.find((c) => c.id === c1);
        assert.equal(top?.parentId, null);

        const { plan } = await untilConfirmed(s);
        assert.deepEqual(restoredIds(plan), ['category:cat']);
        for (let i = 0; i < 3; i++) {
            s.wait(1);
            await s.cycle();
        }

        const newCat = fluxerIdOf(s, 'category', 'cat');
        assert.notEqual(newCat, oldCat);
        const moved = s.guild.snapshot.channels.find((c) => c.id === c1);
        assert.equal(moved?.parentId, newCat);
    });

    it('recreates a role and points channel overwrites at the new one', async () => {
        const s = await synced(
            discordGuild({
                roles: [
                    role(discordGuild().guildId, {
                        name: '@everyone',
                        position: 0,
                    }),
                    role('r1', { name: 'Members' }),
                ],
                channels: [
                    channel('101', {
                        overwrites: [
                            { id: 'r1', type: 0, allow: '1024', deny: '0' },
                        ],
                    }),
                ],
            })
        );
        const oldRole = fluxerIdOf(s, 'role', 'r1');
        const chan = fluxerIdOf(s, 'channel', '101');
        const ids = () =>
            s.guild.snapshot.channels
                .find((c) => c.id === chan)
                ?.overwrites.map((o) => o.id);
        assert.ok(ids()?.includes(oldRole));
        s.guild.removeByHand(oldRole);

        const { plan } = await untilConfirmed(s);
        assert.deepEqual(restoredIds(plan), ['role:r1']);
        for (let i = 0; i < 3; i++) {
            s.wait(1);
            await s.cycle();
        }

        const newRole = fluxerIdOf(s, 'role', 'r1');
        assert.notEqual(newRole, oldRole);
        assert.ok(ids()?.includes(newRole));
    });

    it('recreates an emoji and a sticker', async () => {
        const s = await synced(
            discordGuild({
                emojis: [{ id: 'e1', name: 'wave', animated: false }],
                stickers: [
                    {
                        id: 's1',
                        name: 'cat',
                        description: 'a cat',
                        tags: 'cat',
                    },
                ],
            })
        );
        const oldEmoji = fluxerIdOf(s, 'emoji', 'e1');
        const oldSticker = fluxerIdOf(s, 'sticker', 's1');
        s.guild.removeByHand(oldEmoji, oldSticker);

        const { plan } = await untilConfirmed(s);
        assert.deepEqual(restoredIds(plan), ['emoji:e1', 'sticker:s1']);
        s.wait(1);
        await s.cycle();

        const emoji = fluxerIdOf(s, 'emoji', 'e1');
        const sticker = fluxerIdOf(s, 'sticker', 's1');
        assert.notEqual(emoji, oldEmoji);
        assert.notEqual(sticker, oldSticker);
        assert.ok(s.guild.snapshot.emojis.some((e) => e.id === emoji));
        assert.ok(s.guild.snapshot.stickers.some((x) => x.id === sticker));
        assert.equal(s.linker.unlinked.length, 0);
    });
});

describe('restore timing', () => {
    it('counts only from the first healthy snapshot the copy is missing in', async () => {
        const s = await synced(forum(), true);
        const oldId = fluxerIdOf(s, 'thread', 'post1');
        s.guild.removeByHand(oldId);
        await s.cycle();
        assert.equal(rowOf(s, 'thread', 'post1')?.destMissingCount, 1);
        assert.equal(
            rowOf(s, 'thread', 'post1')?.destMissingSince?.getTime(),
            s.state.now.getTime()
        );
        assert.ok(s.state.now.getTime() > NOW.getTime());
    });
});

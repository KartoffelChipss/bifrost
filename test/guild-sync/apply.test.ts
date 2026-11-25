import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlags } from '@fluxerjs/util';
import { PermissionFlagsBits } from 'discord.js';
import {
    EXPRESSION_WRITE_MS,
    MAX_FAILURES_PER_KIND,
    SLOW_WRITE_MS,
} from '../../src/guild-sync/apply';
import { runCycle } from '../../src/guild-sync/cycle';
import {
    FAILURES_BEFORE_BACKOFF,
    MemoryFailureLedger,
} from '../../src/guild-sync/failures';
import { isRemoval } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import { FakeGuild } from './fake-guild';
import { LINK, opCount, setup } from './harness';
import {
    D_GUILD,
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    role,
} from './fixtures';

const bits = (value: bigint) => value.toString();
const VIEW = bits(PermissionFlagsBits.ViewChannel);

/** A server with one role, one category and a private channel in it. */
function sourceGuild(overrides: Partial<GuildSnapshot> = {}): GuildSnapshot {
    return discordGuild({
        roles: [role(D_GUILD), role('r1', { name: 'Mods', position: 1 })],
        channels: [
            channel('cat', { type: 4, name: 'Staff' }),
            channel('c1', {
                name: 'mod-chat',
                parentId: 'cat',
                overwrites: [
                    { id: D_GUILD, type: 0, allow: '0', deny: VIEW },
                    { id: 'r1', type: 0, allow: VIEW, deny: '0' },
                ],
            }),
        ],
        ...overrides,
    });
}

const named = (guild: FakeGuild, name: string) =>
    guild.snapshot.channels.find((c) => c.name === name);

describe('applying a plan', () => {
    it('builds the structure and records ownership', async () => {
        const { store, guild, cycle } = setup(sourceGuild());
        const { applied } = await cycle();
        assert.equal(applied?.failed, 0);
        assert.deepEqual(guild.calls, [
            'create role Mods',
            'create channel Staff',
            'create channel mod-chat',
        ]);
        const mods = guild.snapshot.roles.find((r) => r.name === 'Mods');
        const chat = named(guild, 'mod-chat');
        assert.ok(mods && chat);
        assert.equal(chat.parentId, named(guild, 'Staff')?.id);
        // The channel is private from its first moment: both overwrites
        // are part of the create call.
        assert.deepEqual(chat.overwrites, [
            { id: F_GUILD, type: 0, allow: '0', deny: VIEW },
            { id: mods.id, type: 0, allow: VIEW, deny: '0' },
        ]);
        const created = store.rows.filter((r) => r.createdBySync);
        assert.deepEqual(created.map((r) => r.kind).sort(), [
            'category',
            'channel',
            'role',
        ]);
        assert.equal(store.plans[0].status, 'applied');
        assert.ok(store.audits.every((a) => a.result !== 'failed'));
        // Each create records its intent first (adopt.ts).
        const intents = store.audits.filter((a) => a.result === 'intent');
        assert.equal(intents.length, 3);
    });

    it('plans nothing more once the structure is applied', async () => {
        const { guild, cycle } = setup(sourceGuild());
        await cycle();
        const writes = guild.calls.length;
        const second = await cycle();
        assert.equal(opCount(second.plan), 0);
        assert.deepEqual(second.plan.body.findings, []);
        assert.equal(guild.calls.length, writes);
    });

    it('asks for another cycle while ops wait over the write cap', async () => {
        const { store, guild, cycle } = setup(sourceGuild());
        store.settings = { ...store.settings, writeCapPerCycle: 1 };
        const outcomes = [await cycle(), await cycle(), await cycle()];
        assert.deepEqual(
            outcomes.map((o) => o.more),
            [true, true, false]
        );
        assert.equal(guild.calls.length, 3);
    });

    it('adds an overwrite later when its role could not be created first', async () => {
        const { guild, cycle } = setup(sourceGuild());
        guild.failCreates.add('Mods');
        const first = await cycle();
        assert.equal(first.applied?.failed, 1);
        assert.equal(first.more, false);
        // Without the role, the channel has only the @everyone deny.
        assert.equal(named(guild, 'mod-chat')?.overwrites.length, 1);
        guild.failCreates.clear();
        await cycle();
        await cycle();
        const mods = guild.snapshot.roles.find((r) => r.name === 'Mods');
        assert.deepEqual(
            named(guild, 'mod-chat')?.overwrites.map((o) => o.id),
            [F_GUILD, mods?.id]
        );
    });

    it('stops after too many failed writes', async () => {
        const names = ['a', 'b', 'c', 'd', 'e'];
        const { store, guild, cycle } = setup(
            discordGuild({
                roles: [
                    role(D_GUILD),
                    ...names.map((n) => role(n, { name: n })),
                ],
            })
        );
        for (const name of names) guild.failCreates.add(name);
        const { applied } = await cycle();
        assert.equal(applied?.failed, MAX_FAILURES_PER_KIND);
        assert.equal(
            applied?.skipped.filter((s) => /role writes failed/.test(s.reason))
                .length,
            names.length - MAX_FAILURES_PER_KIND
        );
        assert.equal(store.plans[0].status, 'aborted');
        assert.equal(
            store.audits.filter((a) => a.result === 'failed').length,
            MAX_FAILURES_PER_KIND
        );
    });
});

describe('first sync of @everyone and the server', () => {
    const everyone = (permissions: bigint) =>
        role(D_GUILD, { permissions: bits(permissions) });

    it('copies @everyone once and keeps destination-only bits', async () => {
        const source = discordGuild({
            name: 'Real name',
            roles: [everyone(PermissionFlagsBits.SendMessages)],
        });
        const { store, guild, cycle } = setup(source);
        const fluxerOnly = PermissionFlags.UpdateRtcRegion;
        guild.snapshot = fluxerGuild({
            roles: [role(F_GUILD, { permissions: bits(fluxerOnly) })],
        });
        const { plan } = await cycle();
        assert.ok(
            plan.body.ops.every((op) => op.op !== 'update' || op.baseline)
        );
        assert.equal(guild.snapshot.name, 'Real name');
        assert.equal(
            guild.snapshot.roles[0].permissions,
            bits(PermissionFlags.SendMessages | fluxerOnly)
        );
        const baselines = store.rows.filter((r) => !r.createdBySync);
        assert.deepEqual(baselines.map((r) => r.kind).sort(), [
            'guild',
            'role',
        ]);
    });

    it('reports a later destination edit as drift and leaves it', async () => {
        const source = discordGuild({
            roles: [everyone(PermissionFlagsBits.SendMessages)],
        });
        const { guild, cycle } = setup(source);
        await cycle();
        await guild.updateRole(F_GUILD, F_GUILD, { permissions: '0' });
        await guild.renameGuild(F_GUILD, 'Renamed by hand');
        const writes = guild.calls.length;
        const { plan } = await cycle();
        assert.equal(opCount(plan), 0);
        assert.equal(
            plan.body.findings.filter((f) => f.type === 'drift').length,
            2
        );
        assert.equal(guild.calls.length, writes);
    });

    it('records the baseline even when nothing differed', async () => {
        const { store, cycle } = setup(
            sourceGuild({ channels: [channel('c')] })
        );
        await cycle();
        assert.equal(store.rows.filter((r) => !r.createdBySync).length, 2);
    });
});

describe('when a plan is not applied', () => {
    const quiet = async (
        change: (s: ReturnType<typeof setup>) => void
    ): Promise<ReturnType<typeof setup>> => {
        const s = setup(sourceGuild());
        change(s);
        const { applied } = await s.cycle();
        assert.equal(applied, undefined);
        assert.deepEqual(s.guild.calls, []);
        assert.deepEqual(s.store.rows, []);
        return s;
    };

    it('writes nothing while the link is in dry-run', async () => {
        const { store } = await quiet((s) => {
            s.store.settings = { ...s.store.settings, mode: 'dry-run' };
        });
        assert.equal(store.plans[0].status, 'dry-run');
    });

    it('writes nothing unless the environment allows apply', async () => {
        await quiet((s) => {
            s.state.allowApply = false;
        });
    });

    it('stops writing when add-ons trip to read-only', async () => {
        const s = setup(sourceGuild());
        const calls = s.guild.calls;
        // The first write trips the mode, as an add-on error would.
        s.guild.createRole = async () => {
            calls.push('create role');
            s.state.processMode = 'read-only';
            return 'f-role-x';
        };
        const { applied } = await s.cycle();
        assert.deepEqual(calls, ['create role']);
        assert.equal(applied?.stopped, 'writes were switched off');
    });
});

describe('destination drift on an applied object', () => {
    it('leaves a hand edit, then follows the next source change', async () => {
        const { guild, discord, cycle } = setup(sourceGuild());
        await cycle();
        const chat = named(guild, 'mod-chat');
        assert.ok(chat);
        await guild.updateChannel(F_GUILD, chat.id, { name: 'hand-edit' });
        const drifted = await cycle();
        assert.equal(opCount(drifted.plan), 0);
        assert.equal(named(guild, 'hand-edit')?.id, chat.id);

        const renamed = sourceGuild();
        discord.result = {
            ok: true,
            snapshot: {
                ...renamed,
                channels: renamed.channels.map((c) =>
                    c.id === 'c1' ? { ...c, name: 'mod-lounge' } : c
                ),
            },
        };
        await cycle();
        assert.equal(named(guild, 'mod-lounge')?.id, chat.id);
    });
});

describe('emojis and stickers', () => {
    const withExpressions = () =>
        discordGuild({
            emojis: [
                { id: 'e1', name: 'wave', animated: false },
                { id: 'e2', name: 'party', animated: true },
            ],
            stickers: [
                { id: 's1', name: 'hello', description: 'hi', tags: 'wave' },
            ],
        });

    it('copies each image from the source and records ownership', async () => {
        const s = setup(withExpressions());
        s.assets.animated.add('e2');
        const { applied } = await s.cycle();
        assert.equal(applied?.failed, 0);
        assert.deepEqual(s.assets.requests, [
            'emoji:e1',
            'emoji:e2',
            'sticker:s1',
        ]);
        assert.deepEqual(
            s.guild.snapshot.emojis.map((e) => [e.name, e.animated]),
            [
                ['wave', false],
                ['party', true],
            ]
        );
        assert.equal(s.guild.snapshot.stickers[0]?.tags, 'wave');
        const second = await s.cycle();
        assert.equal(opCount(second.plan), 0);
    });

    it('renames an emoji when the source name changes', async () => {
        const s = setup(withExpressions());
        await s.cycle();
        const next = withExpressions();
        s.discord.result = {
            ok: true,
            snapshot: {
                ...next,
                emojis: [
                    { id: 'e1', name: 'hi', animated: false },
                    next.emojis[1],
                ],
            },
        };
        await s.cycle();
        assert.deepEqual(
            s.guild.snapshot.emojis.map((e) => e.name),
            ['hi', 'party']
        );
    });

    it('paces writes to the destination rate limits', async () => {
        const s = setup(
            discordGuild({
                roles: [role(D_GUILD), role('r1')],
                emojis: [{ id: 'e1', name: 'wave', animated: false }],
            })
        );
        await s.cycle();
        assert.deepEqual(s.pauses, [
            SLOW_WRITE_MS,
            SLOW_WRITE_MS,
            EXPRESSION_WRITE_MS,
        ]);
    });
});

describe('removals', () => {
    /** Applies the structure, then removes objects from the source. */
    async function removed(sourceIds: string[], source = sourceGuild()) {
        const s = setup(source);
        await s.cycle();
        s.discord.result = {
            ok: true,
            snapshot: {
                ...source,
                roles: source.roles.filter((r) => !sourceIds.includes(r.id)),
                channels: source.channels.filter(
                    (c) => !sourceIds.includes(c.id)
                ),
            },
        };
        s.discord.gone = new Set(sourceIds);
        return s;
    }

    /** Three checks, 20 minutes apart: enough to confirm a removal. */
    async function confirm(s: Awaited<ReturnType<typeof removed>>) {
        await s.cycle();
        s.wait(20);
        await s.cycle();
        s.wait(20);
        return s.cycle();
    }

    it('archives a removed channel only after it is confirmed gone', async () => {
        const s = await removed(['c1']);
        const chat = named(s.guild, 'mod-chat');
        assert.ok(chat);
        const early = await s.cycle();
        assert.equal(opCount(early.plan), 0);
        s.wait(20);
        await s.cycle();
        s.wait(20);
        const { applied } = await s.cycle();
        assert.equal(applied?.applied, 1);
        const archive = named(s.guild, 'archived-sync');
        const after = s.guild.snapshot.channels.find((c) => c.id === chat.id);
        assert.ok(archive && after);
        assert.equal(after.parentId, archive.id);
        const everyone = after.overwrites.find((o) => o.id === F_GUILD);
        assert.equal(
            BigInt(everyone?.deny ?? '0') & PermissionFlags.SendMessages,
            PermissionFlags.SendMessages
        );
        const row = s.store.rows.find((r) => r.fluxerId === chat.id);
        assert.equal(row?.state, 'archived');
    });

    it('deletes an archived object after the grace period', async () => {
        const s = await removed(['r1']);
        await confirm(s);
        const mods = s.guild.snapshot.roles.find((r) =>
            r.name.includes('Mods')
        );
        assert.equal(mods?.name, '[archived] Mods');
        assert.equal(mods?.permissions, '0');
        s.wait(13 * 24 * 60);
        const early = await s.cycle();
        assert.equal(opCount(early.plan), 0);
        s.wait(2 * 24 * 60);
        await s.cycle();
        assert.equal(
            s.guild.snapshot.roles.some((r) => r.id === mods?.id),
            false
        );
        const row = s.store.rows.find((r) => r.fluxerId === mods?.id);
        assert.equal(row?.state, 'tombstoned');
    });

    it('never removes while the source read fails', async () => {
        const s = await removed(['c1']);
        s.discord.result = { ok: false, reason: 'error', detail: '503' };
        const writes = s.guild.calls.length;
        for (let i = 0; i < 4; i++) {
            const { plan } = await s.cycle();
            assert.equal(plan.status, 'aborted');
            s.wait(20);
        }
        assert.equal(s.guild.calls.length, writes);
    });
});

describe('approval', () => {
    const big = () =>
        discordGuild({
            roles: [
                role(D_GUILD),
                ...['a', 'b', 'c', 'd'].map((n) => role(n, { name: n })),
            ],
        });

    /** Four roles removed at once: over the cycle budget of three. */
    async function overBudget() {
        const s = setup(big());
        s.store.settings = { ...s.store.settings, adminChannelId: 'admin' };
        await s.cycle();
        s.discord.result = {
            ok: true,
            snapshot: discordGuild({ roles: [role(D_GUILD)] }),
        };
        s.discord.gone = new Set(['a', 'b', 'c', 'd']);
        // Four of five roles gone would trip the shrink check first.
        s.store.settings = { ...s.store.settings, shrinkPercent: 100 };
        await s.cycle();
        s.wait(20);
        await s.cycle();
        s.wait(20);
        return s;
    }

    const removalCount = (plan: Plan) =>
        [...plan.body.ops, ...plan.body.deferred].filter(isRemoval).length;

    const archived = (s: ReturnType<typeof setup>) =>
        s.guild.snapshot.roles.filter((r) => r.name.startsWith('[archived]'));

    it('holds a plan over the delete budget until an admin approves it', async () => {
        const s = await overBudget();
        const pending = await s.cycle();
        assert.equal(pending.plan.status, 'pending-approval');
        assert.equal(archived(s).length, 0);
        const notice = s.posted[s.posted.length - 1];
        assert.equal(notice.channelId, 'admin');
        assert.match(
            notice.text,
            new RegExp(`sync approve ${pending.plan.id}`)
        );

        await s.store.setApprovedPlan(LINK.id, pending.plan.id);
        const { applied } = await s.cycle();
        assert.equal(applied?.applied, 4);
        assert.equal(archived(s).length, 4);
        assert.equal(s.store.settings.approvedPlanId, null);
    });

    it('keeps an approval through a failed read', async () => {
        const s = await overBudget();
        const pending = await s.cycle();
        await s.store.setApprovedPlan(LINK.id, pending.plan.id);
        const good = s.discord.result;
        s.discord.result = { ok: false, reason: 'error', detail: '503' };
        await s.cycle();
        assert.equal(s.store.settings.approvedPlanId, pending.plan.id);
        s.discord.result = good;
        const { applied } = await s.cycle();
        assert.equal(applied?.applied, 4);
    });

    it('lets an approval cover fewer removals, never more', async () => {
        const s = await overBudget();
        s.store.settings = { ...s.store.settings, deleteBudgetPerCycle: 1 };
        const pending = await s.cycle();
        assert.equal(removalCount(pending.plan), 4);
        await s.store.setApprovedPlan(LINK.id, pending.plan.id);
        // One role comes back: the other three were approved.
        s.discord.result = {
            ok: true,
            snapshot: discordGuild({
                roles: [role(D_GUILD), role('a', { name: 'a' })],
            }),
        };
        const next = await s.cycle();
        assert.equal(removalCount(next.plan), 3);
        assert.equal(next.applied?.applied, 3);
        assert.equal(archived(s).length, 3);
        assert.equal(s.store.settings.approvedPlanId, null);
    });

    it('needs a new approval for a removal outside the approved set', async () => {
        const s = await overBudget();
        const pending = await s.cycle();
        // An approval that covered only three of the four removals.
        const { ops } = pending.plan.body;
        const approved = {
            ...pending.plan,
            id: 'approved-subset',
            body: {
                ...pending.plan.body,
                ops: ops.filter(isRemoval).slice(0, 3),
                deferred: [],
            },
        };
        await s.store.savePlan(approved);
        await s.store.setApprovedPlan(LINK.id, approved.id);
        const next = await s.cycle();
        assert.equal(next.plan.status, 'pending-approval');
        assert.equal(archived(s).length, 0);
    });

    it('accepts a shrink only after it is approved', async () => {
        const many = Array.from({ length: 20 }, (_, i) => channel(`c${i}`));
        const s = setup(discordGuild({ channels: many }));
        s.store.settings = { ...s.store.settings, adminChannelId: 'admin' };
        await s.cycle();
        s.discord.result = {
            ok: true,
            snapshot: discordGuild({ channels: many.slice(0, 5) }),
        };
        const stopped = await s.cycle();
        assert.equal(stopped.plan.status, 'pending-approval');
        assert.match(stopped.plan.abortReason ?? '', /shrink check/);
        const again = await s.cycle();
        assert.equal(again.plan.status, 'pending-approval');
        // The same pending plan is posted once, not on every cycle.
        assert.equal(
            s.posted.filter((n) => /shrink check/.test(n.text)).length,
            1
        );

        await s.store.setApprovedPlan(LINK.id, again.plan.id);
        const accepted = await s.cycle();
        assert.equal(accepted.plan.abortReason, null);
        const after = await s.cycle();
        assert.equal(after.plan.abortReason, null);
    });
});

describe('channel links, forum tags and threads', () => {
    const forumGuild = (overrides: Partial<GuildSnapshot> = {}) =>
        discordGuild({
            channels: [
                channel('forum', {
                    type: 15,
                    name: 'game-chat',
                    tags: ['news', 'help'],
                }),
                channel('text', { name: 'general' }),
                channel('voice', { type: 2, name: 'lounge' }),
            ],
            threads: [
                {
                    id: 'post1',
                    parentId: 'forum',
                    name: 'Patch notes',
                    archived: false,
                    locked: false,
                    tags: ['news'],
                },
                {
                    id: 'old',
                    parentId: 'forum',
                    name: 'Old post',
                    archived: true,
                    locked: true,
                    tags: [],
                },
                {
                    id: 'side',
                    parentId: 'text',
                    name: 'Side chat',
                    archived: false,
                    locked: false,
                    tags: [],
                },
            ],
            ...overrides,
        });

    /** Runs cycles until one applies nothing, at most `limit` times. */
    async function settle(s: ReturnType<typeof setup>, limit = 6) {
        for (let i = 0; i < limit; i++) {
            const { applied } = await s.cycle();
            if (!applied || applied.applied === 0) return;
        }
        assert.fail('the sync did not settle');
    }

    it('bridges forum and voice channels, never the admin channel', async () => {
        const s = setup(forumGuild({ threads: [] }));
        s.useLinks();
        s.store.settings = { ...s.store.settings, adminChannelId: 'text' };
        await settle(s);
        assert.deepEqual(
            s.linker.links.map((l) => l.discordChannelId),
            ['forum', 'voice']
        );
        assert.equal(
            s.linker.links[0].fluxerChannelId,
            named(s.guild, 'game-chat')?.id
        );
    });

    it('creates the forum with its tags', async () => {
        const s = setup(forumGuild({ threads: [] }));
        await s.cycle();
        assert.deepEqual(named(s.guild, 'game-chat')?.tags, ['news', 'help']);
    });

    it('creates each post with its first message through the forum webhook', async () => {
        const s = setup(forumGuild());
        s.useLinks();
        await settle(s);
        const post = s.guild.posts.find((p) => p.name === 'Patch notes');
        assert.ok(post);
        assert.equal(post.starter?.content, 'first message of post1');
        assert.equal(post.starter?.username, 'author');
        assert.equal(post.webhook?.id, `fw-${named(s.guild, 'game-chat')?.id}`);
        assert.deepEqual(post.tags, ['news']);
        // A thread in a text channel has no first message of its own.
        const side = s.guild.posts.find((p) => p.name === 'Side chat');
        assert.equal(side?.starter, null);
        const old = s.guild.snapshot.threads.find((t) => t.name === 'Old post');
        assert.equal(old?.archived, true);
        assert.equal(old?.locked, true);
        assert.equal(s.store.rows.filter((r) => r.kind === 'thread').length, 3);
        const again = await s.cycle();
        assert.equal(opCount(again.plan), 0);
    });

    it('waits with a forum post until its forum is bridged', async () => {
        const s = setup(forumGuild());
        await s.cycle();
        const { applied } = await s.cycle();
        assert.equal(applied?.failed, 0);
        assert.ok(
            applied?.skipped.some((x) => /not linked yet/.test(x.reason))
        );
        assert.equal(
            s.guild.posts.some((p) => p.name === 'Patch notes'),
            false
        );
    });

    it('follows a renamed, retagged and archived post', async () => {
        const s = setup(forumGuild());
        s.useLinks();
        await settle(s);
        const source = forumGuild();
        s.discord.result = {
            ok: true,
            snapshot: {
                ...source,
                threads: source.threads.map((t) =>
                    t.id === 'post1'
                        ? {
                              ...t,
                              name: 'Patch 2',
                              archived: true,
                              tags: ['help'],
                          }
                        : t
                ),
            },
        };
        await s.cycle();
        const post = s.guild.snapshot.threads.find((t) => t.name === 'Patch 2');
        assert.equal(post?.archived, true);
        assert.deepEqual(post?.tags, ['help']);
    });

    it('copies listed posts but removes none while a thread list is incomplete', async () => {
        const s = setup(forumGuild({ threadGaps: ['forum'] }));
        s.useLinks();
        await settle(s);
        assert.equal(s.guild.posts.length, 3);
        const { plan } = await s.cycle();
        assert.ok(
            plan.body.findings.some(
                (f) => f.kind === 'thread' && /incomplete/.test(f.detail)
            )
        );
        // A listed post disappears while the gap remains: no removal.
        const source = forumGuild({ threadGaps: ['forum'] });
        s.discord.result = {
            ok: true,
            snapshot: {
                ...source,
                threads: source.threads.filter((t) => t.id !== 'post1'),
            },
        };
        s.discord.gone = new Set(['post1']);
        for (let i = 0; i < 4; i++) {
            const next = await s.cycle();
            assert.ok(next.plan.body.ops.every((op) => !isRemoval(op)));
            s.wait(20);
        }
    });

    it('never plans a link the bot cannot make', async () => {
        const base = forumGuild({ threads: [] });
        const s = setup({
            ...base,
            channels: base.channels.map((c) =>
                c.id === 'voice' ? { ...c, bridgeable: false } : c
            ),
        });
        s.useLinks();
        s.store.settings = { ...s.store.settings, adminChannelId: 'text' };
        await settle(s);
        assert.deepEqual(
            s.linker.links.map((l) => l.discordChannelId),
            ['forum']
        );
        const { plan } = await s.cycle();
        assert.ok(
            plan.body.findings.some(
                (f) => f.id === 'voice' && /Manage Webhooks/.test(f.detail)
            )
        );
    });

    it('removes the bridge before it deletes a channel', async () => {
        const s = setup(forumGuild({ threads: [] }));
        s.useLinks();
        await settle(s);
        const source = forumGuild({ threads: [] });
        s.discord.result = {
            ok: true,
            snapshot: {
                ...source,
                channels: source.channels.filter((c) => c.id !== 'text'),
            },
        };
        s.discord.gone = new Set(['text']);
        await s.cycle();
        s.wait(20);
        await s.cycle();
        s.wait(20);
        await s.cycle();
        assert.equal(s.linker.unlinked.length, 0);
        s.wait(15 * 24 * 60);
        await s.cycle();
        assert.deepEqual(s.linker.unlinked, ['text']);
        assert.equal(named(s.guild, 'general'), undefined);
    });
});

describe('bridging after history', () => {
    const twoChannels = () =>
        discordGuild({
            channels: [
                channel('text', { name: 'general' }),
                channel('forum', { type: 15, name: 'game-chat' }),
            ],
        });

    it('bridges a forum at once but a text channel only once its history is copied', async () => {
        const s = setup(twoChannels());
        s.useLinks();
        const ready = new Set<string>();
        s.historyReady(ready);
        await s.cycle();
        await s.cycle();
        assert.deepEqual(
            s.linker.links.map((l) => l.discordChannelId),
            ['forum']
        );
        ready.add('text');
        await s.cycle();
        assert.deepEqual(s.linker.links.map((l) => l.discordChannelId).sort(), [
            'forum',
            'text',
        ]);
    });
});

describe('excluded channels', () => {
    const ADMIN = '126729786981744640';
    const STAFF = '452223817377382440';
    const guild = () =>
        discordGuild({
            channels: [
                channel(STAFF, { type: 4, name: 'Staff' }),
                channel(ADMIN, { name: 'admins-only', parentId: STAFF }),
                channel('general', { name: 'general' }),
            ],
            threads: [
                {
                    id: 'side',
                    parentId: ADMIN,
                    name: 'Secret',
                    archived: false,
                    locked: false,
                    tags: [],
                },
            ],
        });

    function excluding(ids: string[]) {
        const s = setup(guild());
        s.useLinks();
        s.exclude(ids);
        return s;
    }

    it('never creates, bridges or threads an excluded channel', async () => {
        const s = excluding([ADMIN]);
        await s.cycle();
        await s.cycle();
        assert.equal(named(s.guild, 'admins-only'), undefined);
        assert.ok(named(s.guild, 'Staff'));
        assert.deepEqual(
            s.linker.links.map((l) => l.discordChannelId),
            ['general']
        );
        assert.equal(s.guild.posts.length, 0);
        const { plan } = await s.cycle();
        assert.ok(
            plan.body.findings.some(
                (f) =>
                    f.id === ADMIN &&
                    /BF_ADDONS_EXCLUDE_CHANNELS/.test(f.detail)
            )
        );
    });

    it('excludes every channel in an excluded category', async () => {
        const s = excluding([STAFF]);
        await s.cycle();
        assert.equal(named(s.guild, 'Staff'), undefined);
        assert.equal(named(s.guild, 'admins-only'), undefined);
        assert.ok(named(s.guild, 'general'));
    });

    it('leaves an existing copy alone when its channel is excluded later', async () => {
        const s = setup(guild());
        await s.cycle();
        const copy = named(s.guild, 'admins-only');
        assert.ok(copy);
        s.exclude([ADMIN]);
        const renamed = guild();
        s.discord.result = {
            ok: true,
            snapshot: {
                ...renamed,
                channels: renamed.channels.map((c) =>
                    c.id === ADMIN ? { ...c, name: 'renamed' } : c
                ),
            },
        };
        for (let i = 0; i < 4; i++) {
            await s.cycle();
            s.wait(20);
        }
        assert.equal(named(s.guild, 'admins-only')?.id, copy.id);
        const row = s.store.rows.find((r) => r.fluxerId === copy.id);
        assert.equal(row?.state, 'active');
    });
});

describe('recovering from partial and failed writes', () => {
    it('owns a new role before its follow-up, and retries the follow-up', async () => {
        const source = discordGuild({
            roles: [role(D_GUILD), role('r1', { name: 'Mods', hoist: true })],
        });
        const s = setup(source);
        // The follow-up write fails the first time.
        const originalCreate = s.guild.createRole.bind(s.guild);
        s.guild.createRole = async (guildId, spec) => {
            const id = await originalCreate(guildId, spec);
            s.guild.failUpdates.add(id);
            return id;
        };
        const first = await s.cycle();
        assert.equal(first.applied?.failed, 1);
        const mods = s.guild.snapshot.roles.find((r) => r.name === 'Mods');
        assert.ok(mods);
        assert.equal(mods.hoist, false);
        assert.ok(s.store.rows.some((r) => r.fluxerId === mods.id));
        s.guild.failUpdates.clear();
        const second = await s.cycle();
        const update = second.plan.body.ops.find((op) => op.op === 'update');
        assert.equal(
            update?.op === 'update' && update.changes[0].field,
            'hoist'
        );
        assert.equal(
            s.guild.snapshot.roles.find((r) => r.id === mods.id)?.hoist,
            true
        );
        // Exactly one Mods role: nothing was created twice.
        assert.equal(
            s.guild.snapshot.roles.filter((r) => r.name === 'Mods').length,
            1
        );
    });

    it('keeps other kinds going when one kind keeps failing', async () => {
        const names = ['a', 'b', 'c', 'd'];
        const s = setup(
            discordGuild({
                roles: [
                    role(D_GUILD),
                    ...names.map((n) => role(n, { name: n })),
                ],
                channels: [channel('c1', { name: 'general' })],
            })
        );
        for (const name of names) s.guild.failCreates.add(name);
        const { applied } = await s.cycle();
        assert.equal(applied?.failed, MAX_FAILURES_PER_KIND);
        assert.ok(named(s.guild, 'general'));
    });

    it('waits out a backoff for an op that keeps failing', async () => {
        const s = setup(
            discordGuild({ roles: [role(D_GUILD), role('a', { name: 'a' })] })
        );
        s.guild.failCreates.add('a');
        const deps = { failures: new MemoryFailureLedger() };
        const run = async () =>
            (await runCycle(LINK, { ...s.depsFor(), ...deps })) as Extract<
                Awaited<ReturnType<typeof runCycle>>,
                { status: 'planned' }
            >;
        for (let i = 0; i < FAILURES_BEFORE_BACKOFF; i++) {
            assert.equal((await run()).applied?.failed, 1);
        }
        const held = await run();
        assert.equal(held.applied?.failed, 0);
        assert.match(held.applied?.skipped[0]?.reason ?? '', /backoff/);
    });

    it('stops writing once the leader lock is lost', async () => {
        const s = setup(sourceGuild());
        const outcome = await runCycle(LINK, {
            ...s.depsFor(),
            stillLeader: async () => false,
        });
        assert.ok(outcome.status === 'planned');
        assert.match(outcome.applied?.stopped ?? '', /leader lock/);
        assert.deepEqual(s.guild.calls, []);
    });

    it('tombstones a removed object someone already deleted by hand', async () => {
        const source = sourceGuild();
        const s = setup(source);
        await s.cycle();
        const chat = named(s.guild, 'mod-chat');
        assert.ok(chat);
        s.discord.result = {
            ok: true,
            snapshot: {
                ...source,
                channels: source.channels.filter((c) => c.id !== 'c1'),
            },
        };
        s.discord.gone = new Set(['c1']);
        // A Fluxer admin deletes the copy before the sync archives it.
        s.guild.snapshot = {
            ...s.guild.snapshot,
            channels: s.guild.snapshot.channels.filter((c) => c.id !== chat.id),
        };
        await s.cycle();
        s.wait(20);
        await s.cycle();
        s.wait(20);
        const { applied } = await s.cycle();
        assert.equal(applied?.failed, 0);
        const row = s.store.rows.find((r) => r.fluxerId === chat.id);
        assert.equal(row?.state, 'tombstoned');
    });

    it('finishes a hard delete when the object is already gone', async () => {
        const source = sourceGuild();
        const s = setup(source);
        await s.cycle();
        const mods = s.guild.snapshot.roles.find((r) => r.name === 'Mods');
        assert.ok(mods);
        s.discord.result = {
            ok: true,
            snapshot: { ...source, roles: [role(D_GUILD)] },
        };
        s.discord.gone = new Set(['r1']);
        await s.cycle();
        s.wait(20);
        await s.cycle();
        s.wait(20);
        await s.cycle();
        // Deleted by hand during the grace period.
        s.guild.snapshot = {
            ...s.guild.snapshot,
            roles: s.guild.snapshot.roles.filter((r) => r.id !== mods.id),
        };
        s.wait(15 * 24 * 60);
        const { applied } = await s.cycle();
        assert.equal(applied?.failed, 0);
        const row = s.store.rows.find((r) => r.fluxerId === mods.id);
        assert.equal(row?.state, 'tombstoned');
    });
});

describe('order of new objects', () => {
    it('moves new roles into the source order, then reports later moves as drift', async () => {
        const source = discordGuild({
            roles: [
                role(D_GUILD),
                role('low', { name: 'low', position: 1 }),
                role('high', { name: 'high', position: 2 }),
            ],
        });
        const s = setup(source);
        // Fluxer puts each new role at the bottom, so creates invert them.
        s.guild.createRole = (() => {
            const create = FakeGuild.prototype.createRole.bind(s.guild);
            return async (guildId, spec) => {
                const id = await create(guildId, spec);
                s.guild.snapshot = {
                    ...s.guild.snapshot,
                    roles: s.guild.snapshot.roles.map((r) =>
                        r.id === id
                            ? { ...r, position: 1 }
                            : r.id === F_GUILD
                              ? r
                              : { ...r, position: r.position + 1 }
                    ),
                };
                return id;
            };
        })();
        await s.cycle();
        const second = await s.cycle();
        assert.ok(second.plan.body.ops.some((op) => op.op === 'reorder'));
        const byName = (n: string) =>
            s.guild.snapshot.roles.find((r) => r.name === n)?.position ?? 0;
        assert.ok(byName('high') > byName('low'));
        const third = await s.cycle();
        assert.equal(opCount(third.plan), 0);
        // A hand move on Fluxer now counts as drift.
        s.guild.snapshot = {
            ...s.guild.snapshot,
            roles: s.guild.snapshot.roles.map((r) =>
                r.name === 'high'
                    ? { ...r, position: 0 }
                    : r.name === 'low'
                      ? { ...r, position: 9 }
                      : r
            ),
        };
        const fourth = await s.cycle();
        assert.equal(opCount(fourth.plan), 0);
        assert.ok(
            fourth.plan.body.findings.some(
                (f) => f.type === 'drift' && f.kind === 'role'
            )
        );
    });
});

describe('role icons', () => {
    it('uploads the source image for a role icon', async () => {
        const s = setup(
            discordGuild({
                roles: [
                    role(D_GUILD),
                    role('r1', { name: 'Mods', icon: 'h1' }),
                ],
            })
        );
        await s.cycle();
        await s.cycle();
        assert.ok(s.assets.requests.includes('role-icon:r1'));
        const third = await s.cycle();
        assert.equal(opCount(third.plan), 0);
    });
});

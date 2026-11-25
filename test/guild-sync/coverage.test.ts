import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diff, type DiffInput } from '../../src/guild-sync/diff';
import { trackMissing } from '../../src/guild-sync/guards';
import { IdMap } from '../../src/guild-sync/idmap';
import type { PlanOp } from '../../src/guild-sync/ops';
import type { ChannelSnap, ThreadSnap } from '../../src/guild-sync/snapshot';
import { writeFor, type WriteContext } from '../../src/guild-sync/writes';
import {
    D_GUILD,
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    mapRow,
    role,
} from './fixtures';

function input(overrides: Partial<DiffInput> = {}): DiffInput {
    return {
        source: discordGuild(),
        destination: fluxerGuild(),
        previousSource: null,
        rows: [],
        direction: 'discord-to-fluxer',
        ...overrides,
    };
}

const forum = (overrides: Partial<ChannelSnap> = {}): ChannelSnap =>
    channel('forum', {
        type: 15,
        name: 'game-chat',
        tags: ['news'],
        defaultAutoArchive: 4320,
        defaultThreadSlowmode: 0,
        forum: {
            defaultReaction: { emojiId: null, emojiName: '👍' },
            sortOrder: 1,
            layout: 2,
            tags: [
                {
                    name: 'news',
                    moderated: true,
                    emojiId: 'e1',
                    emojiName: null,
                },
            ],
        },
        ...overrides,
    });

const updates = (ops: PlanOp[]) =>
    ops.filter(
        (op): op is Extract<PlanOp, { op: 'update' }> => op.op === 'update'
    );

describe('forum settings', () => {
    it('creates a forum with its defaults and tag details, emojis mapped', () => {
        const source = discordGuild({ channels: [forum()] });
        const ctx: WriteContext = {
            source,
            destination: fluxerGuild(),
            direction: 'discord-to-fluxer',
            map: new IdMap(
                [mapRow('emoji', 'e1', 'fe1')],
                'discord-to-fluxer',
                D_GUILD,
                F_GUILD
            ),
        };
        const action = writeFor(
            {
                op: 'create',
                kind: 'channel',
                sourceId: 'forum',
                name: 'game-chat',
                existingDestId: null,
            },
            ctx
        );
        assert.ok(action.type === 'create-channel');
        assert.equal(action.spec.defaultAutoArchive, 4320);
        assert.deepEqual(action.spec.defaultReaction, { name: '👍' });
        assert.equal(action.spec.sortOrder, 1);
        assert.equal(action.spec.layout, 2);
        assert.deepEqual(action.spec.tagMeta, [
            { name: 'news', moderated: true, emoji: { id: 'fe1' } },
        ]);
    });

    it('follows a changed default reaction', () => {
        const result = diff(
            input({
                source: discordGuild({
                    channels: [
                        forum({
                            forum: {
                                ...forum().forum!,
                                defaultReaction: {
                                    emojiId: null,
                                    emojiName: '🎉',
                                },
                            },
                        }),
                    ],
                }),
                destination: fluxerGuild({
                    channels: [forum({ id: 'fforum' })],
                }),
                previousSource: discordGuild({ channels: [forum()] }),
                rows: [
                    mapRow('emoji', 'e1', 'e1'),
                    mapRow('channel', 'forum', 'fforum'),
                ],
            })
        );
        const [update] = updates(result.ops);
        assert.deepEqual(
            update?.changes.map((c) => [c.field, c.to]),
            [['defaultReaction', { name: '🎉' }]]
        );
    });
});

describe('roles', () => {
    it('sets a new role emoji icon in the follow-up', () => {
        const source = discordGuild({
            roles: [role(D_GUILD), role('r1', { unicodeEmoji: '🛡️' })],
        });
        const action = writeFor(
            {
                op: 'create',
                kind: 'role',
                sourceId: 'r1',
                name: 'r1',
                existingDestId: null,
            },
            {
                source,
                destination: fluxerGuild(),
                direction: 'discord-to-fluxer',
                map: new IdMap([], 'discord-to-fluxer', D_GUILD, F_GUILD),
            }
        );
        assert.ok(action.type === 'create-role');
        assert.equal(action.applied.unicodeEmoji, null);
        assert.deepEqual(action.followUp?.patch, { unicodeEmoji: '🛡️' });
    });

    it('copies a changed role icon, compared only with the last write', () => {
        const result = diff(
            input({
                source: discordGuild({
                    roles: [role(D_GUILD), role('r1', { icon: 'hash-b' })],
                }),
                destination: fluxerGuild({
                    roles: [role(F_GUILD), role('fr1')],
                }),
                rows: [
                    mapRow('role', 'r1', 'fr1', {
                        appliedFields: { icon: 'hash-a' },
                    }),
                ],
            })
        );
        const [update] = updates(result.ops);
        assert.deepEqual(
            update?.changes.find((c) => c.field === 'icon'),
            { field: 'icon', from: 'hash-a', to: 'hash-b' }
        );
    });
});

describe('server settings', () => {
    const settings = {
        systemChannelId: 'c1',
        afkChannelId: null,
        afkTimeout: 300,
        verificationLevel: 4,
        defaultNotifications: 1,
        explicitContentFilter: 2,
    };

    it('copies settings on first sync, channels mapped and levels capped', () => {
        const result = diff(
            input({
                source: discordGuild({ channels: [channel('c1')], settings }),
                destination: fluxerGuild({
                    channels: [channel('f1')],
                    settings: {
                        systemChannelId: null,
                        afkChannelId: null,
                        afkTimeout: 300,
                        verificationLevel: 0,
                        defaultNotifications: 0,
                        explicitContentFilter: 0,
                    },
                }),
                rows: [mapRow('channel', 'c1', 'f1')],
            })
        );
        const guild = updates(result.ops).find((op) => op.kind === 'guild');
        assert.deepEqual(
            Object.fromEntries(
                guild?.changes.map((c) => [c.field, c.to]) ?? []
            ),
            {
                systemChannelId: 'f1',
                verificationLevel: 3,
                defaultNotifications: 1,
                explicitContentFilter: 2,
            }
        );
        const action = writeFor(guild!, {
            source: discordGuild(),
            destination: fluxerGuild(),
            direction: 'discord-to-fluxer',
            map: new IdMap([], 'discord-to-fluxer', D_GUILD, F_GUILD),
        });
        assert.ok(action.type === 'update-guild');
        assert.equal(action.patch.systemChannelId, 'f1');
    });
});

describe('member overwrites', () => {
    const VIEW = '1024';
    const withMember = (id: string) =>
        channel('c1', {
            overwrites: [{ id, type: 1, allow: '0', deny: VIEW }],
        });

    it('copies a linked member overwrite as a member overwrite', () => {
        const result = diff(
            input({
                source: discordGuild({ channels: [withMember('u1')] }),
                members: new Map([['u1', 'fu1']]),
            })
        );
        const create = result.ops.find((op) => op.op === 'create');
        assert.ok(create);
        const action = writeFor(create, {
            source: discordGuild({ channels: [withMember('u1')] }),
            destination: fluxerGuild(),
            direction: 'discord-to-fluxer',
            map: new IdMap([], 'discord-to-fluxer', D_GUILD, F_GUILD),
            members: new Map([['u1', 'fu1']]),
        });
        assert.ok(action.type === 'create-channel');
        assert.deepEqual(action.spec.overwrites, [
            { id: 'fu1', type: 1, allow: '0', deny: VIEW },
        ]);
    });

    it('reports an unlinked member deny it cannot copy', () => {
        const result = diff(
            input({ source: discordGuild({ channels: [withMember('u2')] }) })
        );
        const finding = result.findings.find(
            (f) => f.id === 'c1' && /member overwrites/.test(f.detail)
        );
        assert.match(finding?.detail ?? '', /1 of them deny access/);
    });
});

describe('threads', () => {
    const thread = (overrides: Partial<ThreadSnap> = {}): ThreadSnap => ({
        id: 't1',
        parentId: 'c1',
        name: 'side',
        archived: false,
        locked: false,
        tags: [],
        private: true,
        invitable: false,
        pinned: false,
        rateLimitPerUser: 30,
        autoArchiveDuration: 4320,
        ...overrides,
    });

    it('creates a private thread, then sets slowmode and archive time', () => {
        const source = discordGuild({
            channels: [channel('c1')],
            threads: [thread()],
        });
        const action = writeFor(
            {
                op: 'create',
                kind: 'thread',
                sourceId: 't1',
                name: 'side',
                existingDestId: null,
            },
            {
                source,
                destination: fluxerGuild(),
                direction: 'discord-to-fluxer',
                map: new IdMap(
                    [mapRow('channel', 'c1', 'f1')],
                    'discord-to-fluxer',
                    D_GUILD,
                    F_GUILD
                ),
            }
        );
        assert.ok(action.type === 'create-thread');
        assert.equal(action.private, true);
        assert.equal(action.invitable, false);
        assert.deepEqual(action.followUp?.patch, {
            rateLimitPerUser: 30,
            autoArchiveDuration: 4320,
        });
        assert.equal(action.applied.rateLimitPerUser, 0);
        assert.equal('autoArchiveDuration' in action.applied, false);
    });

    it('never counts a private copy missing while private threads are hidden', () => {
        const row = mapRow('thread', 't1', 'ft1', {
            appliedFields: { private: true },
        });
        const hidden = discordGuild({ privateThreadGaps: ['c1'] });
        assert.deepEqual(
            trackMissing([row], hidden, 'discord-to-fluxer', new Date()),
            []
        );
        const visible = discordGuild();
        assert.equal(
            trackMissing([row], visible, 'discord-to-fluxer', new Date())
                .length,
            1
        );
    });
});

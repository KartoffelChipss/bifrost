import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SnapshotSide } from '../../src/addons/db/schema';
import { diff } from '../../src/guild-sync/diff';
import { mirrorMayWrite } from '../../src/guild-sync/index';
import { MemoryParkedMessages } from '../../src/guild-sync/parkedMessages';
import type { ThreadSnap } from '../../src/guild-sync/snapshot';
import type {
    NewMapping,
    SyncSettings,
    ThreadMessage,
} from '../../src/guild-sync/store';
import {
    ThreadMirror,
    type DiscordThreadInfo,
    type FluxerThreadInfo,
    type ThreadLook,
} from '../../src/guild-sync/threadMirror';
import { ThreadRelay } from '../../src/guild-sync/threadRelay';
import { UnrecordedWriteError } from '../../src/addons/isolation';
import { createRecordingLogger } from '../addons/fakes';
import { DEFAULT_SETTINGS, FakeLinker } from './fake-store';
import { channel, discordGuild, fluxerGuild, mapRow } from './fixtures';

class MirrorStore {
    pairs: { guildLinkId: string; discordId: string; fluxerId: string }[] = [];
    messages: ThreadMessage[] = [];
    mappings: NewMapping[] = [];

    async findThreadPair(side: SnapshotSide, threadId: string) {
        const key = side === 'discord' ? 'discordId' : 'fluxerId';
        return this.pairs.find((p) => p[key] === threadId) ?? null;
    }

    async saveThreadMessage(message: ThreadMessage) {
        this.messages.push(message);
    }

    async findThreadMessage(side: SnapshotSide, id: string) {
        const key = side === 'discord' ? 'discordMessageId' : 'fluxerMessageId';
        return this.messages.find((m) => m[key] === id) ?? null;
    }

    async deleteThreadMessage() {}

    failInsert = false;

    async insertMapping(mapping: NewMapping) {
        if (this.failInsert) throw new Error('connection reset');
        this.mappings.push(mapping);
        if (mapping.discordId && mapping.fluxerId) {
            this.pairs.push({
                guildLinkId: mapping.guildLinkId,
                discordId: mapping.discordId,
                fluxerId: mapping.fluxerId,
            });
        }
        return mapping;
    }
}

const post = (overrides: Partial<FluxerThreadInfo> = {}): FluxerThreadInfo => ({
    id: 'f-post',
    parentId: 'f-forum',
    name: 'LAN this weekend?',
    ownerId: 'fluxer-user',
    forum: true,
    tags: ['news'],
    archived: false,
    locked: false,
    ...overrides,
});

/** What Discord gives a new copy: the name, Discord's defaults, known tags. */
function discordLook(info: FluxerThreadInfo): ThreadLook {
    return {
        name: info.name,
        archived: false,
        locked: false,
        tags: info.tags.filter((t) => t === 'news'),
        private: info.private === true,
        ...(info.private === true ? { invitable: false } : {}),
        pinned: false,
        rateLimitPerUser: 0,
        autoArchiveDuration: 1440,
    };
}

interface SetupOptions {
    archive?: boolean;
    /** Linked accounts, Discord user ID to Fluxer user ID. */
    accounts?: ReadonlyMap<string, string>;
    /** Active Discord threads in the linked channel. */
    active?: DiscordThreadInfo[];
}

async function setup(
    info: FluxerThreadInfo | null = post(),
    options: SetupOptions = {}
) {
    const store = new MirrorStore();
    const links = new FakeLinker();
    await links.link('link-1', 'd-forum', 'f-forum');
    const calls: string[] = [];
    const state = {
        apply: true,
        canPrivate: true,
        excluded: false,
        look: discordLook,
    };
    const logger = createRecordingLogger();
    const parked = new MemoryParkedMessages();
    const mirror = new ThreadMirror({
        store,
        ports: {
            fluxerThread: async () => info,
            fluxerBotId: () => 'fluxer-bot',
            discordBotId: () => 'discord-bot',
            activeDiscordThreads: async () => options.active ?? [],
            async createDiscordPost(_link, thread, starter) {
                calls.push(`post ${thread.name} ${String(starter)}`);
                return {
                    id: 'd-post',
                    ownerId: 'dw-d-forum',
                    look: state.look(thread),
                };
            },
            async createDiscordThread(_link, thread) {
                if (thread.private === true && !state.canPrivate) return null;
                const kind = thread.private === true ? 'private' : 'thread';
                calls.push(`${kind} ${thread.name}`);
                return {
                    id: 'd-thread',
                    ownerId: 'discord-bot',
                    look: state.look(thread),
                };
            },
            fluxerThreadMembers: async () => ['fluxer-user', 'fluxer-unlinked'],
            async addDiscordThreadMembers(threadId, userIds) {
                calls.push(`members ${threadId} ${userIds.join(',')}`);
            },
        },
        mayWrite: async () => state.apply,
        linkedAccounts: options.accounts
            ? async () => options.accounts ?? new Map()
            : undefined,
        now: () => new Date(0),
        logger,
    });
    const relay = new ThreadRelay({
        store,
        links,
        ports: {
            async send(to, _link, threadId, raw) {
                calls.push(`send ${to} ${threadId} ${String(raw)}`);
                return 'copy';
            },
            async edit() {},
            async remove() {},
            async fetch() {
                return null;
            },
        },
        active: () => true,
        mirror: (link, event, raw) => mirror.mirror(link, event, raw),
        isArchiveThread: async () => options.archive === true,
        parked,
        excluded: async () => state.excluded,
        now: () => new Date(0),
        logger: createRecordingLogger(),
    });
    return { store, calls, state, relay, mirror, links, parked, logger };
}

const inFluxerPost = (id: string, channelId = 'f-post') => ({
    id,
    channelId,
    parentId: 'f-forum',
    webhookId: null,
});

describe('a thread started on Fluxer', () => {
    it('becomes a Discord post with its first message, posted once', async () => {
        const s = await setup();
        await s.relay.created('fluxer', inFluxerPost('f-post'), 'starter');
        assert.deepEqual(s.calls, ['post LAN this weekend? starter']);
        assert.equal(s.store.mappings[0]?.kind, 'thread');
        assert.equal(s.store.mappings[0]?.createdBySync, false);
        assert.deepEqual(s.store.messages[0], {
            guildLinkId: 'link-1',
            discordThreadId: 'd-post',
            fluxerThreadId: 'f-post',
            discordMessageId: 'd-post',
            fluxerMessageId: 'f-post',
        });
    });

    it('relays later replies into the new post', async () => {
        const s = await setup();
        await s.relay.created('fluxer', inFluxerPost('f-post'), 'starter');
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, [
            'post LAN this weekend? starter',
            'send discord d-post reply',
        ]);
    });

    it('fetches the first message when a reply comes first', async () => {
        const s = await setup();
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, [
            'post LAN this weekend? null',
            'send discord d-post reply',
        ]);
    });

    it('starts a plain thread in a text channel', async () => {
        const s = await setup(post({ forum: false, tags: [] }));
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, [
            'thread LAN this weekend?',
            'send discord d-thread reply',
        ]);
    });

    it('makes one copy for a burst of replies', async () => {
        const s = await setup();
        await Promise.all([
            s.relay.created('fluxer', inFluxerPost('r1'), 'one'),
            s.relay.created('fluxer', inFluxerPost('r2'), 'two'),
        ]);
        assert.equal(s.calls.filter((c) => c.startsWith('post')).length, 1);
        assert.equal(s.calls.filter((c) => c.startsWith('send')).length, 2);
    });

    it('makes one copy when called for the same thread at once', async () => {
        // Called directly, without the relay's per-thread queue.
        const s = await setup();
        const link = s.links.links[0];
        const results = await Promise.all([
            s.mirror.mirror(link, inFluxerPost('f-post'), 'starter'),
            s.mirror.mirror(link, inFluxerPost('r1'), 'reply'),
        ]);
        assert.equal(s.calls.filter((c) => c.startsWith('post')).length, 1);
        assert.equal(s.store.mappings.length, 1);
        const [first, second] = results;
        assert.ok(first && first !== 'skip' && first.starterCopied);
        assert.ok(second && second !== 'skip' && !second.starterCopied);
        assert.equal(second.pair.discordId, 'd-post');
    });

    it('holds the reply outside apply mode', async () => {
        const s = await setup();
        s.state.apply = false;
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, []);
        assert.equal(s.store.mappings.length, 0);
        assert.equal(await s.parked.waiting('fluxer', 'f-post'), true);
        assert.equal(s.parked.size, 1);
    });

    it('waits for a thread the sync itself may be creating', async () => {
        // The bot, unknown, or the link's webhook: Fluxer names the webhook
        // as the owner of a forum post the sync started.
        for (const ownerId of ['fluxer-bot', null, 'fw-f-forum']) {
            const s = await setup(post({ ownerId }));
            await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
            assert.deepEqual(s.calls, [], `owner ${String(ownerId)}`);
            assert.equal(s.store.mappings.length, 0);
        }
    });

    it('raises an unrecorded write when the new thread cannot be saved', async () => {
        const s = await setup();
        s.store.failInsert = true;
        await assert.rejects(
            s.relay.created('fluxer', inFluxerPost('r1'), 'reply'),
            UnrecordedWriteError
        );
    });

    it('never relays or copies a history archive thread', async () => {
        const s = await setup(post(), { archive: true });
        await s.relay.created('fluxer', inFluxerPost('r1'), 'imported');
        assert.deepEqual(s.calls, []);
        assert.equal(s.store.mappings.length, 0);
    });

    it('never relays or copies a thread in an excluded channel', async () => {
        const s = await setup();
        s.state.excluded = true;
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, []);
        assert.equal(s.store.mappings.length, 0);
        assert.equal(s.parked.size, 0);
    });
});

describe('a private thread started on Fluxer', () => {
    const secret = () =>
        post({ forum: false, tags: [], private: true, invitable: false });

    it('becomes a private Discord thread with its linked members', async () => {
        const accounts = new Map([
            ['discord-user', 'fluxer-user'],
            ['discord-outsider', 'fluxer-outsider'],
        ]);
        const s = await setup(secret(), { accounts });
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, [
            'private LAN this weekend?',
            'members d-thread discord-user',
            'send discord d-thread reply',
        ]);
        assert.equal(s.store.mappings[0]?.appliedFields.private, true);
    });

    it('is not copied when no private Discord thread can be made', async () => {
        const s = await setup(secret());
        s.state.canPrivate = false;
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, []);
        assert.equal(s.store.mappings.length, 0);
        // Never copied, so its replies are not held either.
        assert.equal(s.parked.size, 0);
        assert.ok(
            s.logger.entries.some(
                (e) => e.level === 'warn' && e.message.includes('private')
            )
        );
    });

    it('is never copied as a forum post', async () => {
        const s = await setup(post({ private: true }));
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, []);
        assert.equal(s.store.mappings.length, 0);
    });
});

/** A snowflake made `ms` after 2026-01-01, as both platforms make them. */
function snowflake(ms: number): string {
    const at = Date.UTC(2026, 0, 1) + ms - 1420070400000;
    return (BigInt(at) << BigInt(22)).toString();
}

describe('a copy an earlier attempt made but did not record', () => {
    const fluxerId = snowflake(0);
    const info = () => post({ id: fluxerId, forum: false, tags: [] });
    const found = (
        id: string,
        ownerId: string,
        name = 'LAN this weekend?'
    ) => ({
        id,
        ownerId,
        look: { ...discordLook(info()), name },
    });

    it('is adopted instead of starting a second thread', async () => {
        const earlier = found(snowflake(1_000), 'discord-bot');
        const s = await setup(info(), { active: [earlier] });
        await s.relay.created('fluxer', inFluxerPost('r1', fluxerId), 'reply');
        assert.deepEqual(s.calls, [`send discord ${earlier.id} reply`]);
        assert.equal(s.store.mappings[0]?.discordId, earlier.id);
    });

    it('is never someone else’s, an older, or a mapped thread', async () => {
        const mapped = found(snowflake(2_000), 'discord-bot');
        const s = await setup(info(), {
            active: [
                found(snowflake(1_000), 'discord-user'),
                found(snowflake(-600_000), 'discord-bot'),
                found(snowflake(1_000), 'discord-bot', 'other name'),
                mapped,
            ],
        });
        s.store.pairs.push({
            guildLinkId: 'link-1',
            discordId: mapped.id,
            fluxerId: 'f-other',
        });
        await s.relay.created('fluxer', inFluxerPost('r1', fluxerId), 'reply');
        assert.deepEqual(s.calls, [
            'thread LAN this weekend?',
            'send discord d-thread reply',
        ]);
    });
});

describe('the cycle after a mirror', () => {
    /** The Fluxer thread with settings Discord's new copy did not take. */
    const original = post({
        tags: ['fluxer-only', 'news'],
        locked: true,
        rateLimitPerUser: 30,
        autoArchiveDuration: 4320,
        private: false,
        pinned: false,
    });

    function plan(mapping: NewMapping, copy: ThreadSnap) {
        // The diff reads the snapshot fields; ownerId and forum go unread.
        const fluxerThread: ThreadSnap = original;
        return diff({
            source: discordGuild({
                channels: [channel('d-forum', { type: 15 })],
                threads: [copy],
            }),
            destination: fluxerGuild({
                channels: [channel('f-forum', { type: 15 })],
                threads: [fluxerThread],
            }),
            previousSource: null,
            rows: [
                mapRow('channel', 'd-forum', 'f-forum'),
                mapRow('thread', 'd-post', 'f-post', {
                    createdBySync: mapping.createdBySync,
                    appliedFields: mapping.appliedFields,
                }),
            ],
            direction: 'discord-to-fluxer',
        });
    }

    it('writes nothing to the Fluxer thread', async () => {
        const s = await setup(original);
        await s.relay.created('fluxer', inFluxerPost('f-post'), 'starter');
        const mapping = s.store.mappings[0];
        assert.ok(mapping);
        const copy = {
            id: 'd-post',
            parentId: 'd-forum',
            ...discordLook(original),
        };
        const result = plan(mapping, copy);
        const updates = result.ops.filter(
            (op) => op.kind === 'thread' && op.op === 'update'
        );
        assert.deepEqual(updates, []);
    });

    it('follows a later change made on Discord', async () => {
        const s = await setup(original);
        await s.relay.created('fluxer', inFluxerPost('f-post'), 'starter');
        const mapping = s.store.mappings[0];
        assert.ok(mapping);
        const copy = {
            id: 'd-post',
            parentId: 'd-forum',
            ...discordLook(original),
            name: 'Renamed on Discord',
        };
        const updates = plan(mapping, copy).ops.filter(
            (op) => op.kind === 'thread' && op.op === 'update'
        );
        assert.equal(updates.length, 1);
        const op = updates[0];
        assert.ok(op.op === 'update');
        assert.deepEqual(
            op.changes.map((c) => c.field),
            ['name']
        );
    });
});

describe('mirrorMayWrite', () => {
    const check = (
        settings: Partial<SyncSettings>,
        processMode: 'read-only' | 'dry-run' | 'apply' = 'dry-run',
        allowApply = true
    ) =>
        mirrorMayWrite(
            {
                loadSettings: async () => ({
                    ...DEFAULT_SETTINGS,
                    ...settings,
                }),
            },
            {
                mode: { mode: processMode } as never,
                allowApply,
            }
        )('link-1');

    it('allows a Discord-sourced link in apply mode', async () => {
        assert.equal(await check({ mode: 'apply' }), true);
    });

    it('refuses a link whose source is Fluxer', async () => {
        assert.equal(
            await check({ mode: 'apply', direction: 'fluxer-to-discord' }),
            false
        );
    });

    it('refuses dry-run, a kill switch, read-only, or apply not allowed', async () => {
        assert.equal(await check({ mode: 'dry-run' }), false);
        assert.equal(await check({ mode: 'apply', killSwitch: true }), false);
        assert.equal(await check({ mode: 'apply' }, 'read-only'), false);
        assert.equal(await check({ mode: 'apply' }, 'dry-run', false), false);
    });
});

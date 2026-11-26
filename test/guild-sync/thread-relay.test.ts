import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@fluxerjs/core';
import type { WebhookClient } from 'discord.js';
import type { SnapshotSide } from '../../src/addons/db/schema';
import type {
    ThreadMessage,
    ThreadRelayStore,
} from '../../src/guild-sync/store';
import {
    MemoryParkedMessages,
    type ParkedMessageStore,
} from '../../src/guild-sync/parkedMessages';
import {
    MAX_PARKED_FAILURES,
    PARKED_POLL_MS,
    PARKED_TTL_MS,
    ThreadRelay,
    type ThreadMessageEvent,
} from '../../src/guild-sync/threadRelay';
import {
    discordThreadWebhook,
    fluxerAllowedMentions,
    fluxerThreadWebhook,
} from '../../src/guild-sync/threadWebhook';
import { excludedLinks, type LinkedChannel } from '../../src/guild-sync/links';
import { createRecordingLogger } from '../addons/fakes';
import { FakeLinker } from './fake-store';

class FakeThreadStore implements ThreadRelayStore {
    pairs: { guildLinkId: string; discordId: string; fluxerId: string }[] = [];
    messages: ThreadMessage[] = [];
    /** Discord replies history import copied, as `thread message`. */
    covered = new Set<string>();

    async historyCovers(threadId: string, messageId: string) {
        return this.covered.has(`${threadId} ${messageId}`);
    }

    async findThreadPair(side: SnapshotSide, threadId: string) {
        const key = side === 'discord' ? 'discordId' : 'fluxerId';
        return this.pairs.find((p) => p[key] === threadId) ?? null;
    }

    async saveThreadMessage(message: ThreadMessage) {
        this.messages.push(message);
    }

    private key(side: SnapshotSide) {
        return side === 'discord' ? 'discordMessageId' : 'fluxerMessageId';
    }

    async findThreadMessage(side: SnapshotSide, id: string) {
        return this.messages.find((m) => m[this.key(side)] === id) ?? null;
    }

    async deleteThreadMessage(side: SnapshotSide, id: string) {
        this.messages = this.messages.filter((m) => m[this.key(side)] !== id);
    }
}

/** Messages the platforms still have, by ID, as the relay fetches them. */
type Posted = Map<string, unknown>;

/** Records every relayed raw message so a parked one can be fetched. */
function recordPosts(relay: ThreadRelay, posted: Posted) {
    const created = relay.created.bind(relay);
    relay.created = (side, event, raw) => {
        posted.set(event.id, raw);
        return created(side, event, raw);
    };
    return relay;
}

async function setup(parked?: ParkedMessageStore) {
    const store = new FakeThreadStore();
    const links = new FakeLinker();
    await links.link('link-1', 'd-forum', 'f-forum');
    store.pairs.push({
        guildLinkId: 'link-1',
        discordId: 'd-post',
        fluxerId: 'f-post',
    });
    const calls: string[] = [];
    const posted: Posted = new Map();
    const state = {
        active: true,
        now: 0,
        failSend: false,
        seq: 0,
        excluded: false,
    };
    const logger = createRecordingLogger();
    const relay = new ThreadRelay({
        store,
        links,
        ports: {
            async send(to, _link, threadId, raw) {
                if (state.failSend) throw new Error('503');
                calls.push(`send ${to} ${threadId} ${String(raw)}`);
                return `copy-${++state.seq}`;
            },
            async edit(to, _link, threadId, messageId) {
                calls.push(`edit ${to} ${threadId} ${messageId}`);
            },
            async remove(to, _link, threadId, messageId) {
                calls.push(`remove ${to} ${threadId} ${messageId}`);
            },
            async fetch(_side, _threadId, messageId) {
                return posted.get(messageId) ?? null;
            },
        },
        active: () => state.active,
        parked,
        excluded: async () => state.excluded,
        now: () => new Date(state.now),
        logger,
    });
    recordPosts(relay, posted);
    return { store, links, calls, state, relay, logger, posted };
}

const inPost = (
    id: string,
    overrides: Partial<ThreadMessageEvent> = {}
): ThreadMessageEvent => ({
    id,
    channelId: 'd-post',
    parentId: 'd-forum',
    webhookId: null,
    ...overrides,
});

/** A reply in a post that is not synced until NEW_PAIR is added. */
const inNew = (id: string) => inPost(id, { channelId: 'd-new' });
const NEW_PAIR = {
    guildLinkId: 'link-1',
    discordId: 'd-new',
    fluxerId: 'f-new',
};

describe('ThreadRelay', () => {
    it('copies a message into the paired thread and records the pair', async () => {
        const { relay, calls, store } = await setup();
        await relay.created('discord', inPost('m1'), 'hello');
        assert.deepEqual(calls, ['send fluxer f-post hello']);
        assert.deepEqual(store.messages, [
            {
                guildLinkId: 'link-1',
                discordThreadId: 'd-post',
                fluxerThreadId: 'f-post',
                discordMessageId: 'm1',
                fluxerMessageId: 'copy-1',
            },
        ]);
    });

    it('copies the other way from Fluxer', async () => {
        const { relay, calls } = await setup();
        const event = inPost('f1', {
            channelId: 'f-post',
            parentId: 'f-forum',
        });
        await relay.created('fluxer', event, 'hi');
        assert.deepEqual(calls, ['send discord d-post hi']);
    });

    it('never copies its own webhook message back', async () => {
        const { relay, calls } = await setup();
        await relay.created(
            'discord',
            inPost('m1', { webhookId: 'dw-d-forum' }),
            'echo'
        );
        assert.deepEqual(calls, []);
    });

    it('ignores messages outside threads and in unbridged channels', async () => {
        const { relay, calls } = await setup();
        await relay.created('discord', inPost('m1', { parentId: null }), 'a');
        await relay.created(
            'discord',
            inPost('m2', { parentId: 'not-linked' }),
            'b'
        );
        assert.deepEqual(calls, []);
    });

    it('holds a message for a thread that is not synced yet, then sends it', async () => {
        const { relay, calls, store } = await setup();
        const event = inPost('m1', { channelId: 'd-new' });
        await relay.created('discord', event, 'early reply');
        await relay.flush();
        assert.deepEqual(calls, []);
        store.pairs.push({
            guildLinkId: 'link-1',
            discordId: 'd-new',
            fluxerId: 'f-new',
        });
        await relay.flush();
        await relay.flush();
        assert.deepEqual(calls, ['send fluxer f-new early reply']);
    });

    it('drops a held message after its time limit', async () => {
        const { relay, calls, store, state } = await setup();
        await relay.created(
            'discord',
            inPost('m1', { channelId: 'd-new' }),
            'x'
        );
        state.now = PARKED_TTL_MS + 1;
        store.pairs.push({
            guildLinkId: 'link-1',
            discordId: 'd-new',
            fluxerId: 'f-new',
        });
        await relay.flush();
        assert.deepEqual(calls, []);
    });

    it('does not hold the first message of a forum post', async () => {
        const { relay, calls, store } = await setup();
        const first = inPost('d-new', { channelId: 'd-new' });
        await relay.created('discord', first, 'starter');
        store.pairs.push({
            guildLinkId: 'link-1',
            discordId: 'd-new',
            fluxerId: 'f-new',
        });
        await relay.flush();
        assert.deepEqual(calls, []);
    });

    it('carries edits and deletes to the copy', async () => {
        const { relay, calls, store } = await setup();
        await relay.created('discord', inPost('m1'), 'hello');
        await relay.edited('discord', inPost('m1'), 'hello again');
        await relay.deleted('discord', 'm1', 'd-forum');
        assert.deepEqual(calls.slice(1), [
            'edit fluxer f-post copy-1',
            'remove fluxer f-post copy-1',
        ]);
        assert.deepEqual(store.messages, []);
        await relay.deleted('discord', 'm1', 'd-forum');
        assert.equal(calls.length, 3);
    });

    it('holds replies while the thread history is being copied', async () => {
        const { store, links, calls, posted } = await setup();
        const importing = new Set(['f-post']);
        const relay = new ThreadRelay({
            store,
            links,
            ports: {
                async send(to, _l, threadId, raw) {
                    calls.push(`send ${to} ${threadId} ${String(raw)}`);
                    return 'copy';
                },
                async edit() {},
                async remove() {},
                async fetch(_side, _thread, id) {
                    return posted.get(id) ?? null;
                },
            },
            active: () => true,
            importing: async (id) => importing.has(id),
            now: () => new Date(0),
            logger: createRecordingLogger(),
        });
        recordPosts(relay, posted);
        await relay.created('discord', inPost('m1'), 'new reply');
        await relay.flush();
        assert.deepEqual(calls, []);
        importing.clear();
        await relay.flush();
        assert.deepEqual(calls, ['send fluxer f-post new reply']);
    });

    async function importingRelay() {
        const s = await setup();
        const importing = new Set(['f-post']);
        const relay = new ThreadRelay({
            store: s.store,
            links: s.links,
            ports: {
                async send(to, _l, threadId, raw) {
                    s.calls.push(`send ${to} ${threadId} ${String(raw)}`);
                    return `copy-${raw}`;
                },
                async edit() {},
                async remove() {},
                async fetch(_side, _thread, id) {
                    return s.posted.get(id) ?? null;
                },
            },
            active: () => true,
            importing: async (id) => importing.has(id),
            now: () => new Date(0),
            logger: createRecordingLogger(),
        });
        recordPosts(relay, s.posted);
        return { ...s, relay, importing };
    }

    it('relays Fluxer replies at once while the history is copied', async () => {
        const { relay, calls } = await importingRelay();
        const event = inPost('f1', {
            channelId: 'f-post',
            parentId: 'f-forum',
        });
        await relay.created('fluxer', event, 'hi');
        assert.deepEqual(calls, ['send discord d-post hi']);
    });

    it('drops held replies the history import covered', async () => {
        const { relay, calls, store, importing } = await importingRelay();
        await relay.created('discord', inPost('m1'), 'old');
        await relay.created('discord', inPost('m2'), 'new');
        store.covered.add('d-post m1');
        importing.clear();
        await relay.flush();
        assert.deepEqual(calls, ['send fluxer f-post new']);
    });

    it('never posts a held reply deleted while it waited', async () => {
        const { relay, calls, store } = await setup();
        const event = inPost('m1', { channelId: 'd-new' });
        await relay.created('discord', event, 'gone soon');
        await relay.deleted('discord', 'm1', 'd-forum', 'd-new');
        store.pairs.push(NEW_PAIR);
        await relay.flush();
        assert.deepEqual(calls, []);
    });

    it('drops a held reply that is gone when it is retried', async () => {
        const { relay, calls, store, posted } = await setup();
        await relay.created('discord', inNew('m1'), 'x');
        posted.delete('m1');
        store.pairs.push(NEW_PAIR);
        await relay.flush();
        assert.deepEqual(calls, []);
    });

    it('parks a new reply behind older held ones, keeping the order', async () => {
        const { relay, calls, store } = await setup();
        await relay.created('discord', inNew('m1'), 'one');
        store.pairs.push(NEW_PAIR);
        // The thread exists now, but m1 still waits: m2 must not jump it.
        await relay.created('discord', inNew('m2'), 'two');
        assert.deepEqual(calls, [
            'send fluxer f-new one',
            'send fluxer f-new two',
        ]);
    });

    it('stops at the first held reply that must still wait', async () => {
        const { relay, calls, store, state } = await setup();
        await relay.created('discord', inNew('m1'), 'one');
        await relay.created('discord', inNew('m2'), 'two');
        store.pairs.push(NEW_PAIR);
        state.failSend = true;
        await relay.flush();
        state.failSend = false;
        await relay.flush();
        assert.deepEqual(calls, [
            'send fluxer f-new one',
            'send fluxer f-new two',
        ]);
    });

    it('gives up on a held reply that keeps failing', async () => {
        const { relay, calls, store, state } = await setup();
        await relay.created('discord', inNew('m1'), 'bad');
        await relay.created('discord', inNew('m2'), 'ok');
        store.pairs.push(NEW_PAIR);
        state.failSend = true;
        for (let i = 0; i < MAX_PARKED_FAILURES; i++) await relay.flush();
        state.failSend = false;
        await relay.flush();
        assert.deepEqual(calls, ['send fluxer f-new ok']);
    });

    it('keeps held replies in the given store across a restart', async () => {
        const parked = new MemoryParkedMessages();
        const first = await setup(parked);
        await first.relay.created('discord', inNew('m1'), 'kept');
        assert.equal(parked.size, 1);
        // A new relay on the same store, as after a restart.
        const second = await setup(parked);
        second.posted.set('m1', 'kept');
        second.store.pairs.push(NEW_PAIR);
        await second.relay.flush();
        assert.deepEqual(second.calls, ['send fluxer f-new kept']);
        assert.equal(parked.size, 0);
    });

    it('retries held replies on a timer while flushing is on', async (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const { relay, calls, store } = await setup();
        await relay.created('discord', inNew('m1'), 'later');
        store.pairs.push(NEW_PAIR);
        relay.startFlushing();
        t.mock.timers.tick(PARKED_POLL_MS);
        relay.stopFlushing();
        for (let i = 0; i < 50 && calls.length === 0; i++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.deepEqual(calls, ['send fluxer f-new later']);
    });

    it('does nothing while add-ons are read-only', async () => {
        const { relay, calls, state } = await setup();
        state.active = false;
        await relay.created('discord', inPost('m1'), 'hello');
        assert.deepEqual(calls, []);
    });

    it('logs a failed send and does not throw', async () => {
        const { relay, state, logger, store } = await setup();
        state.failSend = true;
        await relay.created('discord', inPost('m1'), 'hello');
        assert.match(
            logger.entries[0]?.message ?? '',
            /Thread relay send: 503/
        );
        assert.deepEqual(store.messages, []);
    });

    it('never sends a held reply twice when its copy cannot be recorded', async () => {
        const { relay, calls, store, logger } = await setup();
        await relay.created('discord', inNew('m1'), 'once');
        store.pairs.push(NEW_PAIR);
        store.saveThreadMessage = async () => {
            throw new Error('connection reset');
        };
        await relay.flush();
        await relay.flush();
        assert.deepEqual(calls, ['send fluxer f-new once']);
        assert.ok(
            logger.entries.some((e) =>
                e.message.includes('could not record the copy')
            )
        );
    });

    it('never resends a held reply that could not be dropped after sending', async () => {
        const parked = new FlakyParked();
        const { relay, calls, store } = await setup(parked);
        await relay.created('discord', inNew('m1'), 'once');
        store.pairs.push(NEW_PAIR);
        parked.failRemoves = 1;
        await relay.flush();
        assert.equal(parked.size, 1);
        await relay.flush();
        assert.deepEqual(calls, ['send fluxer f-new once']);
        assert.equal(parked.size, 0);
    });

    it('never resends a held reply when neither the copy nor the drop is saved', async () => {
        const parked = new FlakyParked();
        const { relay, calls, store } = await setup(parked);
        await relay.created('discord', inNew('m1'), 'once');
        store.pairs.push(NEW_PAIR);
        store.saveThreadMessage = async () => {
            throw new Error('connection reset');
        };
        parked.failRemoves = 1;
        await relay.flush();
        await relay.flush();
        assert.deepEqual(calls, ['send fluxer f-new once']);
        assert.equal(parked.size, 0);
    });

    it('relays, edits and deletes nothing in an excluded channel', async () => {
        const { relay, calls, state } = await setup();
        await relay.created('discord', inPost('m1'), 'hello');
        state.excluded = true;
        await relay.created('discord', inPost('m2'), 'excluded');
        await relay.edited('discord', inPost('m1'), 'hello again');
        await relay.deleted('discord', 'm1', 'd-forum');
        assert.deepEqual(calls, ['send fluxer f-post hello']);
    });
});

/** Fails the next `failRemoves` drops, as a database outage would. */
class FlakyParked extends MemoryParkedMessages {
    failRemoves = 0;

    async remove(from: SnapshotSide, messageId: string): Promise<boolean> {
        if (this.failRemoves > 0) {
            this.failRemoves -= 1;
            throw new Error('connection reset');
        }
        return super.remove(from, messageId);
    }
}

describe('stopping the thread relay', () => {
    /** A relay whose sends wait until `release` is called. */
    async function gated() {
        const s = await setup();
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered = () => {};
        const sending = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const relay = new ThreadRelay({
            store: s.store,
            links: s.links,
            ports: {
                async send(to, _l, threadId, raw) {
                    entered();
                    await gate;
                    s.calls.push(`send ${to} ${threadId} ${String(raw)}`);
                    return 'copy';
                },
                async edit() {},
                async remove() {},
                async fetch() {
                    return null;
                },
            },
            active: () => true,
            now: () => new Date(0),
            logger: createRecordingLogger(),
        });
        return { ...s, relay, release, sending };
    }

    it('waits for a send in flight to be recorded', async () => {
        const s = await gated();
        const pending = s.relay.created('discord', inPost('m1'), 'hello');
        await s.sending;
        const stopping = s.relay.stop(5_000);
        s.release();
        assert.equal(await stopping, true);
        assert.equal(s.store.messages.length, 1);
        await pending;
    });

    it('gives up waiting at its deadline', async () => {
        const s = await gated();
        const pending = s.relay.created('discord', inPost('m1'), 'hello');
        await s.sending;
        assert.equal(await s.relay.stop(5), false);
        s.release();
        await pending;
    });

    it('takes no new work once stopped', async () => {
        const { relay, calls } = await setup();
        assert.equal(await relay.stop(5), true);
        await relay.created('discord', inPost('m1'), 'late');
        assert.deepEqual(calls, []);
    });
});

describe('excludedLinks', () => {
    const link = (discordChannelId: string): LinkedChannel => ({
        id: 'l',
        guildLinkId: 'link-1',
        discordChannelId,
        fluxerChannelId: 'f',
        discordWebhook: { id: 'dw', token: 'secret' },
        fluxerWebhook: { id: 'fw', token: 'secret' },
    });
    const categories = new Map([
        ['d-in-cat', 'd-cat'],
        ['d-free', null],
    ]);
    const check = excludedLinks(
        new Set(['d-listed', 'd-cat']),
        async (id) => categories.get(id) ?? null
    );

    it('covers a listed channel and the channels of a listed category', async () => {
        assert.equal(await check(link('d-listed')), true);
        assert.equal(await check(link('d-in-cat')), true);
        assert.equal(await check(link('d-free')), false);
    });

    it('excludes nothing when nothing is listed', async () => {
        const none = excludedLinks(new Set(), async () => {
            throw new Error('not asked');
        });
        assert.equal(await none(link('d-listed')), false);
    });
});

describe('thread webhooks', () => {
    type Call = { route: string; body: unknown };

    function fluxerClient(calls: Call[]) {
        const record = async (route: string, options?: { body?: unknown }) => {
            calls.push({ route, body: options?.body });
        };
        return {
            rest: { post: record, patch: record, delete: record, get: record },
            // The library's webhook constructor asks the client for a user.
            getOrCreateUser: () => ({}),
        } as unknown as Client;
    }

    const ref = { id: 'w1', token: 'secret' };

    it('adds the thread to every Fluxer webhook request', async () => {
        const calls: Call[] = [];
        const webhook = fluxerThreadWebhook(fluxerClient(calls), ref, {
            threadId: 't 1',
        });
        await webhook.client.rest.post('/webhooks/w1/secret?wait=true', {
            body: { content: 'hi' },
        });
        await webhook.client.rest.patch('/webhooks/w1/secret/messages/m1', {});
        await webhook.client.rest.get('/webhooks/w1/secret/messages/m1', {});
        assert.deepEqual(
            calls.map((c) => c.route),
            [
                '/webhooks/w1/secret?wait=true&thread_id=t%201',
                '/webhooks/w1/secret/messages/m1?thread_id=t%201',
                '/webhooks/w1/secret/messages/m1?thread_id=t%201',
            ]
        );
        assert.deepEqual(calls[0].body, { content: 'hi' });
    });

    it('adds extra fields to sends and edits, not to deletes', async () => {
        const calls: Call[] = [];
        const webhook = fluxerThreadWebhook(
            fluxerClient(calls),
            ref,
            { threadId: 't1' },
            { allowed_mentions: { parse: [] } }
        );
        const { rest } = webhook.client;
        await rest.post('/webhooks/w1/secret', { body: { content: 'hi' } });
        await rest.patch('/webhooks/w1/secret/messages/m1', { body: {} });
        await rest.delete('/webhooks/w1/secret/messages/m1', {});
        assert.deepEqual(
            calls.map((c) => c.body),
            [
                { content: 'hi', allowed_mentions: { parse: [] } },
                { allowed_mentions: { parse: [] } },
                undefined,
            ]
        );
    });

    it('lets @everyone ping on Fluxer only when it pinged on Discord', () => {
        assert.deepEqual(
            fluxerAllowedMentions({ mentions: { everyone: true } }),
            {
                parse: ['everyone'],
            }
        );
        // Typed by a member without Mention Everyone: Discord did not ping.
        assert.deepEqual(
            fluxerAllowedMentions({ mentions: { everyone: false } }),
            { parse: [] }
        );
        assert.deepEqual(fluxerAllowedMentions({}), { parse: [] });
    });

    it('starts a forum post by name, with its tags', async () => {
        const calls: Call[] = [];
        const webhook = fluxerThreadWebhook(fluxerClient(calls), ref, {
            threadName: 'Patch notes',
            appliedTags: ['tag1'],
        });
        await webhook.client.rest.post('/webhooks/w1/secret?wait=true', {
            body: { content: 'hi' },
        });
        assert.deepEqual(calls, [
            {
                route: '/webhooks/w1/secret?wait=true',
                body: {
                    content: 'hi',
                    thread_name: 'Patch notes',
                    applied_tags: ['tag1'],
                },
            },
        ]);
    });

    it('adds the thread to Discord webhook sends and edits', async () => {
        const seen: unknown[] = [];
        const base = {
            send: async (options: unknown) => seen.push(options),
            editMessage: async (_id: string, options: unknown) =>
                seen.push(options),
        } as unknown as WebhookClient;
        const scoped = discordThreadWebhook(base, 't1');
        await scoped.send({ content: 'hi' });
        await scoped.editMessage('m1', { content: 'edited' });
        assert.deepEqual(seen, [
            { content: 'hi', threadId: 't1' },
            { content: 'edited', threadId: 't1' },
        ]);
    });
});

describe('MemoryParkedMessages', () => {
    it('keeps the newest messages above its limit', async () => {
        const store = new MemoryParkedMessages(2);
        for (const id of ['a', 'b', 'c']) {
            await store.park({
                from: 'discord',
                messageId: id,
                threadId: 't',
                parentId: 'p',
                webhookId: null,
                parkedAt: 0,
            });
        }
        const list = await store.list('discord', 't', 10);
        assert.deepEqual(
            list.map((m) => m.messageId),
            ['b', 'c']
        );
    });
});

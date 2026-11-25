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
    PARKED_TTL_MS,
    ThreadRelay,
    type ThreadMessageEvent,
} from '../../src/guild-sync/threadRelay';
import {
    discordThreadWebhook,
    fluxerThreadWebhook,
} from '../../src/guild-sync/threadWebhook';
import { createRecordingLogger } from '../addons/fakes';
import { FakeLinker } from './fake-store';

class FakeThreadStore implements ThreadRelayStore {
    pairs: { guildLinkId: string; discordId: string; fluxerId: string }[] = [];
    messages: ThreadMessage[] = [];

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

async function setup() {
    const store = new FakeThreadStore();
    const links = new FakeLinker();
    await links.link('link-1', 'd-forum', 'f-forum');
    store.pairs.push({
        guildLinkId: 'link-1',
        discordId: 'd-post',
        fluxerId: 'f-post',
    });
    const calls: string[] = [];
    const state = { active: true, now: 0, failSend: false, seq: 0 };
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
        },
        active: () => state.active,
        now: () => new Date(state.now),
        logger,
    });
    return { store, links, calls, state, relay, logger };
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
        assert.deepEqual(
            calls.map((c) => c.route),
            [
                '/webhooks/w1/secret?wait=true&thread_id=t%201',
                '/webhooks/w1/secret/messages/m1?thread_id=t%201',
            ]
        );
        assert.deepEqual(calls[0].body, { content: 'hi' });
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

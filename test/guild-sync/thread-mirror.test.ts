import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SnapshotSide } from '../../src/addons/db/schema';
import type { NewMapping, ThreadMessage } from '../../src/guild-sync/store';
import {
    ThreadMirror,
    type FluxerThreadInfo,
} from '../../src/guild-sync/threadMirror';
import { ThreadRelay } from '../../src/guild-sync/threadRelay';
import { createRecordingLogger } from '../addons/fakes';
import { FakeLinker } from './fake-store';

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

    async insertMapping(mapping: NewMapping) {
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

async function setup(info: FluxerThreadInfo | null = post()) {
    const store = new MirrorStore();
    const links = new FakeLinker();
    await links.link('link-1', 'd-forum', 'f-forum');
    const calls: string[] = [];
    const state = { apply: true };
    const mirror = new ThreadMirror({
        store,
        ports: {
            fluxerThread: async () => info,
            fluxerBotId: () => 'fluxer-bot',
            async createDiscordPost(_link, thread, starter) {
                calls.push(`post ${thread.name} ${String(starter)}`);
                return 'd-post';
            },
            async createDiscordThread(_link, thread) {
                calls.push(`thread ${thread.name}`);
                return 'd-thread';
            },
        },
        mayWrite: async () => state.apply,
        now: () => new Date(0),
        logger: createRecordingLogger(),
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
        now: () => new Date(0),
        logger: createRecordingLogger(),
    });
    return { store, calls, state, relay };
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

    it('waits outside apply mode', async () => {
        const s = await setup();
        s.state.apply = false;
        await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
        assert.deepEqual(s.calls, []);
        assert.equal(s.store.mappings.length, 0);
    });

    it('waits for a thread the sync itself may be creating', async () => {
        for (const ownerId of ['fluxer-bot', null]) {
            const s = await setup(post({ ownerId }));
            await s.relay.created('fluxer', inFluxerPost('r1'), 'reply');
            assert.deepEqual(s.calls, []);
        }
    });
});

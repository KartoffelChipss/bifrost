import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
    Events as FluxerEvents,
    ThreadChannel,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import { Events, MessageType, type Client } from 'discord.js';
import {
    listenToDiscordThreads,
    listenToFluxerThreads,
} from '../../src/guild-sync/threadEvents';
import type { ThreadRelay } from '../../src/guild-sync/threadRelay';

type Wrap = Parameters<typeof listenToDiscordThreads>[2];

/** Records relay calls. The wrap keeps each handler's promise to await. */
function fakeRelay() {
    const calls: string[] = [];
    const record =
        (kind: string) =>
        async (side: string, event: { id: string } | string) => {
            const id = typeof event === 'string' ? event : event.id;
            calls.push(`${kind} ${side} ${id}`);
        };
    const relay = {
        created: record('created'),
        edited: record('edited'),
        deleted: record('deleted'),
        startFlushing: () => calls.push('start'),
        stopFlushing: () => calls.push('stop'),
    } as unknown as ThreadRelay;
    const pending: Promise<void>[] = [];
    const wrap: Wrap = (_task, fn) => {
        return (...args) => {
            pending.push(Promise.resolve(fn(...args)));
        };
    };
    return { calls, relay, wrap, flush: () => Promise.all(pending) };
}

export function discordThreadMessage(
    id: string,
    content: string,
    over: Record<string, unknown> = {}
) {
    return {
        id,
        content,
        channelId: 'd-thread',
        channel: { isThread: () => true, parentId: 'd-parent' },
        webhookId: null,
        type: MessageType.Default,
        author: { id: 'user' },
        partial: false,
        editedTimestamp: null,
        ...over,
    };
}

export function fluxerThreadMessage(
    id: string,
    content: string,
    over: Record<string, unknown> = {}
) {
    const channel = Object.create(ThreadChannel.prototype, {
        parentId: { value: 'f-parent' },
    });
    return {
        id,
        content,
        channelId: 'f-thread',
        channel,
        webhookId: null,
        type: 0,
        author: { id: 'user' },
        partial: false,
        editedAt: null,
        ...over,
    };
}

function discordClient() {
    return Object.assign(new EventEmitter(), { user: { id: 'bot' } });
}

describe('thread relay events', () => {
    it('does not relay Discord thread commands', async () => {
        const { calls, relay, wrap, flush } = fakeRelay();
        const client = discordClient();
        listenToDiscordThreads(client as unknown as Client, relay, wrap, '!b ');
        client.emit(Events.MessageCreate, discordThreadMessage('1', '!b link'));
        client.emit(Events.MessageCreate, discordThreadMessage('2', 'hi !b'));
        await flush();
        assert.deepEqual(calls.slice(-1), ['created discord 2']);
        assert.ok(!calls.includes('created discord 1'));
    });

    it('does not relay Fluxer thread commands', async () => {
        const { calls, relay, wrap, flush } = fakeRelay();
        const client = discordClient();
        listenToFluxerThreads(
            client as unknown as FluxerClient,
            relay,
            wrap,
            '!b '
        );
        client.emit(
            FluxerEvents.MessageCreate,
            fluxerThreadMessage('1', '!b help')
        );
        client.emit(FluxerEvents.MessageCreate, fluxerThreadMessage('2', 'ok'));
        await flush();
        assert.deepEqual(calls, ['created fluxer 2']);
    });
});

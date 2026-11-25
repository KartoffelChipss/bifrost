import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
    Events as FluxerEvents,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import { Events, type Client as DiscordClient } from 'discord.js';
import {
    listenToDiscord,
    listenToFluxer,
    MAX_BATCH_REACTIONS,
    type Relays,
    type Wrap,
} from '../../src/relay-extras/events';
import type { PinEvent } from '../../src/relay-extras/pinRelay';
import type { ReactionEvent } from '../../src/relay-extras/reactionRelay';
import type { Side } from '../../src/relay-extras/types';

function fakeRelays() {
    const seen: string[] = [];
    const tasks: string[] = [];
    const record = (kind: string) => async (side: Side, e: object) => {
        seen.push(`${kind} ${side} ${JSON.stringify(e)}`);
    };
    const relays = {
        reactions: { added: record('add'), removed: record('remove') },
        pins: {
            changed: record('pin'),
            pinsChanged: (side: Side, channelId: string) =>
                seen.push(`pins ${side} ${channelId}`),
        },
    } as unknown as Relays;
    const wrap: Wrap = (task, fn) => {
        return (...args) => {
            tasks.push(task);
            void fn(...args);
        };
    };
    return { seen, tasks, relays, wrap };
}

const json = (e: ReactionEvent | PinEvent) => JSON.stringify(e);

function discordReaction(over: Record<string, unknown> = {}) {
    return {
        partial: false,
        count: 2,
        me: true,
        emoji: { id: null, name: '👍', animated: null },
        message: { partial: false, id: 'd-msg', guildId: 'g' },
        ...over,
    };
}

describe('listenToDiscord', () => {
    it('passes reactions with the exact count of other users', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToDiscord(client as unknown as DiscordClient, relays, wrap);
        client.emit(Events.MessageReactionAdd, discordReaction(), { id: 'u' });
        const emoji = { id: null, name: '👍', animated: false };
        assert.deepEqual(seen, [
            `add discord ${json({ messageId: 'd-msg', userId: 'u', emoji, others: 1 })}`,
        ]);
    });

    it('passes no count for a partial reaction or a removal', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToDiscord(client as unknown as DiscordClient, relays, wrap);
        const partial = discordReaction({ partial: true, count: null });
        client.emit(Events.MessageReactionAdd, partial, { id: 'u' });
        client.emit(Events.MessageReactionRemove, discordReaction(), {
            id: 'u',
        });
        assert.match(seen[0], /^add discord .*"others":null/);
        assert.match(seen[1], /^remove discord .*"others":null/);
    });

    it('treats a cleared emoji as a removal with nobody left', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToDiscord(client as unknown as DiscordClient, relays, wrap);
        client.emit(Events.MessageReactionRemoveEmoji, discordReaction());
        assert.match(seen[0], /^remove discord .*"userId":null.*"others":0/);
    });

    it('skips reactions outside a server', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToDiscord(client as unknown as DiscordClient, relays, wrap);
        const dm = discordReaction({ message: { id: 'x', guildId: null } });
        client.emit(Events.MessageReactionAdd, dm, { id: 'u' });
        assert.deepEqual(seen, []);
    });

    it('passes pin state from message updates', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToDiscord(client as unknown as DiscordClient, relays, wrap);
        const next = {
            id: 'd-msg',
            channelId: 'd-chan',
            guildId: 'g',
            pinned: true,
        };
        client.emit(
            Events.MessageUpdate,
            { partial: false, pinned: false },
            next
        );
        client.emit(
            Events.MessageUpdate,
            { partial: true, pinned: null },
            next
        );
        client.emit(
            Events.MessageUpdate,
            { partial: true },
            { ...next, pinned: null }
        );
        assert.deepEqual(seen, [
            `pin discord ${json({ messageId: 'd-msg', channelId: 'd-chan', pinned: true, previous: false })}`,
            `pin discord ${json({ messageId: 'd-msg', channelId: 'd-chan', pinned: true, previous: null })}`,
        ]);
    });

    it('records channel pin events as evidence', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToDiscord(client as unknown as DiscordClient, relays, wrap);
        client.emit(Events.ChannelPinsUpdate, { id: 'd-chan' }, new Date());
        assert.deepEqual(seen, ['pins discord d-chan']);
    });

    it('runs every listener inside the wrap and detaches on stop', () => {
        const { tasks, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        const stop = listenToDiscord(
            client as unknown as DiscordClient,
            relays,
            wrap
        );
        client.emit(Events.MessageReactionAdd, discordReaction(), { id: 'u' });
        assert.deepEqual(tasks, ['reaction-add']);
        stop();
        assert.equal(client.eventNames().length, 0);
    });
});

const fluxerEmoji = { name: '👍' };

describe('listenToFluxer', () => {
    it('passes adds and removals without a count', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToFluxer(client as unknown as FluxerClient, relays, wrap);
        const payload = {
            reaction: { guildId: 'g' },
            messageId: 'f-msg',
            userId: 'u',
            emoji: fluxerEmoji,
        };
        client.emit(FluxerEvents.MessageReactionAdd, payload);
        client.emit(FluxerEvents.MessageReactionRemove, payload);
        const emoji = { id: null, name: '👍', animated: false };
        const event = { messageId: 'f-msg', userId: 'u', emoji, others: null };
        assert.deepEqual(seen, [
            `add fluxer ${json(event)}`,
            `remove fluxer ${json(event)}`,
        ]);
    });

    it('splits a batched add and caps its size', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToFluxer(client as unknown as FluxerClient, relays, wrap);
        const reactions = Array.from(
            { length: MAX_BATCH_REACTIONS + 5 },
            (_, i) => ({
                userId: `u${i}`,
                emoji: { id: '42', name: 'party', animated: true },
            })
        );
        client.emit(FluxerEvents.MessageReactionAddMany, {
            guildId: 'g',
            messageId: 'f-msg',
            reactions,
        });
        assert.equal(seen.length, MAX_BATCH_REACTIONS);
        assert.match(seen[0], /"userId":"u0".*"id":"42"/);
    });

    it('treats a cleared emoji as a removal with nobody left', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToFluxer(client as unknown as FluxerClient, relays, wrap);
        client.emit(FluxerEvents.MessageReactionRemoveEmoji, {
            guildId: 'g',
            messageId: 'f-msg',
            emoji: fluxerEmoji,
        });
        assert.match(seen[0], /^remove fluxer .*"userId":null.*"others":0/);
    });

    it('skips DM reactions', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToFluxer(client as unknown as FluxerClient, relays, wrap);
        client.emit(FluxerEvents.MessageReactionAdd, {
            reaction: { guildId: null },
            messageId: 'x',
            userId: 'u',
            emoji: fluxerEmoji,
        });
        assert.deepEqual(seen, []);
    });

    it('passes pin state, or null for a partial update', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToFluxer(client as unknown as FluxerClient, relays, wrap);
        const next = {
            id: 'f-msg',
            channelId: 'f-chan',
            guildId: 'g',
            partial: false,
            pinned: true,
        };
        client.emit(FluxerEvents.MessageUpdate, { pinned: false }, next);
        client.emit(FluxerEvents.MessageUpdate, null, {
            ...next,
            partial: true,
        });
        assert.deepEqual(seen, [
            `pin fluxer ${json({ messageId: 'f-msg', channelId: 'f-chan', pinned: true, previous: false })}`,
            `pin fluxer ${json({ messageId: 'f-msg', channelId: 'f-chan', pinned: null, previous: null })}`,
        ]);
    });

    it('records channel pin events as evidence', () => {
        const { seen, relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        listenToFluxer(client as unknown as FluxerClient, relays, wrap);
        client.emit(FluxerEvents.ChannelPinsUpdate, {
            channelId: 'f-chan',
            guildId: 'g',
            lastPinTimestamp: null,
        });
        assert.deepEqual(seen, ['pins fluxer f-chan']);
    });

    it('detaches every listener on stop', () => {
        const { relays, wrap } = fakeRelays();
        const client = new EventEmitter();
        const stop = listenToFluxer(
            client as unknown as FluxerClient,
            relays,
            wrap
        );
        assert.equal(client.eventNames().length, 6);
        stop();
        assert.equal(client.eventNames().length, 0);
    });
});

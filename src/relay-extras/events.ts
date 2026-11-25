import type { EventEmitter } from 'node:events';
import {
    Events as FluxerEvents,
    type Client as FluxerClient,
    type ClientEvents as FluxerClientEvents,
    type MessageReactionAddManyPayload,
    type MessageReactionPayload,
    type MessageReactionRemoveEmojiPayload,
} from '@fluxerjs/core';
import {
    Events,
    type Client as DiscordClient,
    type ClientEvents as DiscordClientEvents,
    type Message,
    type MessageReaction,
    type PartialMessage,
    type PartialMessageReaction,
    type PartialUser,
    type User,
} from 'discord.js';
import type { PinRelay } from './pinRelay';
import type { ReactionEvent, ReactionRelay } from './reactionRelay';
import type { ReactionEmoji } from './types';

/**
 * Feeds the reaction and pin relays from both gateways. Each listener calls
 * the relay before its first await, so events reach the relay's queue in
 * gateway order.
 */

export type Wrap = <A extends unknown[]>(
    task: string,
    fn: (...args: A) => Promise<void> | void
) => (...args: A) => void;

export interface Relays {
    readonly reactions: ReactionRelay;
    readonly pins: PinRelay;
}

/** Upper bound on reactions taken from one Fluxer ADD_MANY batch. */
export const MAX_BATCH_REACTIONS = 100;

/** An emitter's listener type; each event passes its own arguments. */
type Handler = Parameters<EventEmitter['on']>[1];
type Listener = readonly [event: string, handler: Handler];

/** A Discord listener, checked against discord.js's event arguments. */
function onDiscord<E extends keyof DiscordClientEvents>(
    event: E,
    handler: (...args: DiscordClientEvents[E]) => void
): Listener {
    return [event, handler as Handler];
}

/** A Fluxer listener, checked against @fluxerjs/core's event arguments. */
function onFluxer<E extends keyof FluxerClientEvents>(
    event: E,
    handler: (...args: FluxerClientEvents[E]) => void
): Listener {
    return [event, handler as Handler];
}

/** Attaches listeners. Returns a function that detaches them. */
function attach(
    emitter: EventEmitter,
    listeners: readonly Listener[]
): () => void {
    for (const [event, handler] of listeners) emitter.on(event, handler);
    return () => {
        for (const [event, handler] of listeners) emitter.off(event, handler);
    };
}

// ---- Discord

type DiscordReaction = MessageReaction | PartialMessageReaction;

export function discordEmoji(reaction: DiscordReaction): ReactionEmoji {
    const { id, name, animated } = reaction.emoji;
    return { id: id ?? null, name: name ?? '', animated: animated ?? false };
}

/** Users other than the bot, when the cached reaction count is exact. */
export function discordOthers(reaction: DiscordReaction): number | null {
    if (reaction.partial || reaction.message.partial) return null;
    return Math.max(0, reaction.count - (reaction.me ? 1 : 0));
}

function discordReactionEvent(
    reaction: DiscordReaction,
    userId: string | null,
    others: number | null
): ReactionEvent | null {
    if (!reaction.message.guildId) return null;
    return {
        messageId: reaction.message.id,
        userId,
        emoji: discordEmoji(reaction),
        others,
    };
}

function discordReactionListeners(relays: Relays, wrap: Wrap): Listener[] {
    const { reactions } = relays;
    const onAdd = (reaction: DiscordReaction, user: User | PartialUser) => {
        const others = discordOthers(reaction);
        const event = discordReactionEvent(reaction, user.id, others);
        if (event) return reactions.added('discord', event);
    };
    // A removal always reads the message again, so no count is passed.
    const onRemove = (reaction: DiscordReaction, user: User | PartialUser) => {
        const event = discordReactionEvent(reaction, user.id, null);
        if (event) return reactions.removed('discord', event);
    };
    const onRemoveEmoji = (reaction: DiscordReaction) => {
        const event = discordReactionEvent(reaction, null, 0);
        if (event) return reactions.removed('discord', event);
    };
    return [
        onDiscord(Events.MessageReactionAdd, wrap('reaction-add', onAdd)),
        onDiscord(
            Events.MessageReactionRemove,
            wrap('reaction-remove', onRemove)
        ),
        onDiscord(
            Events.MessageReactionRemoveEmoji,
            wrap('reaction-remove', onRemoveEmoji)
        ),
    ];
}

function discordPinListener(relays: Relays, wrap: Wrap): Listener {
    const onUpdate = (
        old: Message | PartialMessage,
        next: Message | PartialMessage
    ) => {
        if (!next.guildId || typeof next.pinned !== 'boolean') return;
        return relays.pins.changed('discord', {
            messageId: next.id,
            pinned: next.pinned,
            previous: old.partial ? null : old.pinned,
        });
    };
    return onDiscord(Events.MessageUpdate, wrap('pin', onUpdate));
}

/** Listens on the Discord client. Returns a function that stops it. */
export function listenToDiscord(
    client: DiscordClient,
    relays: Relays,
    wrap: Wrap
): () => void {
    return attach(client, [
        ...discordReactionListeners(relays, wrap),
        discordPinListener(relays, wrap),
    ]);
}

// ---- Fluxer

export function fluxerEmoji(emoji: {
    readonly id?: string | null;
    readonly name: string;
    readonly animated?: boolean;
}): ReactionEmoji {
    return {
        id: emoji.id ?? null,
        name: emoji.name,
        animated: emoji.animated ?? false,
    };
}

function fluxerAddListeners(relays: Relays, wrap: Wrap): Listener[] {
    // Fluxer gateway add events carry no aggregate count (always 1).
    const add = (messageId: string, userId: string, emoji: ReactionEmoji) =>
        relays.reactions.added('fluxer', {
            messageId,
            userId,
            emoji,
            others: null,
        });
    const onAdd = (p: MessageReactionPayload) => {
        if (p.reaction.guildId) {
            return add(p.messageId, p.userId, fluxerEmoji(p.emoji));
        }
    };
    const onAddMany = async (p: MessageReactionAddManyPayload) => {
        if (!p.guildId) return;
        const batch = p.reactions.slice(0, MAX_BATCH_REACTIONS);
        await Promise.all(
            batch.map((r) => add(p.messageId, r.userId, fluxerEmoji(r.emoji)))
        );
    };
    return [
        onFluxer(FluxerEvents.MessageReactionAdd, wrap('reaction-add', onAdd)),
        onFluxer(
            FluxerEvents.MessageReactionAddMany,
            wrap('reaction-add', onAddMany)
        ),
    ];
}

function fluxerRemoveListeners(relays: Relays, wrap: Wrap): Listener[] {
    const { reactions } = relays;
    const onRemove = (p: MessageReactionPayload) => {
        if (!p.reaction.guildId) return;
        return reactions.removed('fluxer', {
            messageId: p.messageId,
            userId: p.userId,
            emoji: fluxerEmoji(p.emoji),
            others: null,
        });
    };
    const onRemoveEmoji = (p: MessageReactionRemoveEmojiPayload) => {
        if (!p.guildId) return;
        return reactions.removed('fluxer', {
            messageId: p.messageId,
            userId: null,
            emoji: fluxerEmoji(p.emoji),
            others: 0,
        });
    };
    return [
        onFluxer(
            FluxerEvents.MessageReactionRemove,
            wrap('reaction-remove', onRemove)
        ),
        onFluxer(
            FluxerEvents.MessageReactionRemoveEmoji,
            wrap('reaction-remove', onRemoveEmoji)
        ),
    ];
}

/** The part of a Fluxer MessageUpdate message the pin relay reads. */
interface FluxerUpdated {
    readonly id: string;
    readonly guildId: string | null;
    readonly partial: boolean;
    readonly pinned?: boolean;
}

function fluxerPinListener(relays: Relays, wrap: Wrap): Listener {
    const onUpdate = (
        old: { readonly pinned: boolean } | null,
        next: FluxerUpdated
    ) => {
        if (!next.guildId) return;
        // A partial update lacks the flag; the relay reads it if needed.
        const pinned =
            !next.partial && typeof next.pinned === 'boolean'
                ? next.pinned
                : null;
        return relays.pins.changed('fluxer', {
            messageId: next.id,
            pinned,
            previous: old ? old.pinned : null,
        });
    };
    return onFluxer(FluxerEvents.MessageUpdate, wrap('pin', onUpdate));
}

/** Listens on one Fluxer client. Returns a function that stops it. */
export function listenToFluxer(
    client: FluxerClient,
    relays: Relays,
    wrap: Wrap
): () => void {
    return attach(client, [
        ...fluxerAddListeners(relays, wrap),
        ...fluxerRemoveListeners(relays, wrap),
        fluxerPinListener(relays, wrap),
    ]);
}

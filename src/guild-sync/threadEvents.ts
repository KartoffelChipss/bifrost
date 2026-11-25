import {
    Events as FluxerEvents,
    ThreadChannel,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import {
    Events,
    MessageType,
    type Client as DiscordClient,
    type Message,
    type PartialMessage,
} from 'discord.js';
import {
    isCommandMessage,
    upstreamCommandPrefix,
} from '../relay-extras/commandPrefix';
import type { ThreadMessageEvent, ThreadRelay } from './threadRelay';

/**
 * Feeds the thread relay from both gateways. Only messages inside threads
 * are passed on; upstream's own handlers deal with channel messages.
 *
 * A message that starts with upstream's command prefix is a command, and
 * upstream's channel relay never copies one; neither does the thread
 * relay (see src/relay-extras/commandPrefix.ts).
 */

/** Message types a person writes. Joins, pins and renames are skipped. */
const DISCORD_USER_TYPES: ReadonlySet<MessageType> = new Set([
    MessageType.Default,
    MessageType.Reply,
]);
const FLUXER_DEFAULT_TYPE = 0;
const FLUXER_REPLY_TYPE = 19;

type Wrap = <A extends unknown[]>(
    task: string,
    fn: (...args: A) => Promise<void> | void
) => (...args: A) => void;

function discordEvent(
    message: Message | PartialMessage
): ThreadMessageEvent | null {
    const channel = message.channel;
    if (!channel.isThread()) return null;
    return {
        id: message.id,
        channelId: message.channelId,
        parentId: channel.parentId,
        webhookId: message.webhookId ?? null,
    };
}

/** Listens on the Discord client. Returns a function that stops it. */
export function listenToDiscordThreads(
    client: DiscordClient,
    relay: ThreadRelay,
    wrap: Wrap,
    prefix: string = upstreamCommandPrefix()
): () => void {
    const onCreate = wrap('thread-message', async (message: Message) => {
        const event = discordEvent(message);
        if (!event || message.author.id === client.user?.id) return;
        if (!DISCORD_USER_TYPES.has(message.type)) return;
        if (isCommandMessage(message.content, prefix)) return;
        await relay.created('discord', event, message);
    });
    const onUpdate = wrap(
        'thread-edit',
        async (
            _old: Message | PartialMessage,
            next: Message | PartialMessage
        ) => {
            const event = discordEvent(next);
            if (!event || next.partial) return;
            await relay.edited('discord', event, next);
        }
    );
    const onDelete = wrap(
        'thread-delete',
        async (message: Message | PartialMessage) => {
            const event = discordEvent(message);
            if (event) await relay.deleted('discord', event.id, event.parentId);
        }
    );
    client.on(Events.MessageCreate, onCreate);
    client.on(Events.MessageUpdate, onUpdate);
    client.on(Events.MessageDelete, onDelete);
    return () => {
        client.off(Events.MessageCreate, onCreate);
        client.off(Events.MessageUpdate, onUpdate);
        client.off(Events.MessageDelete, onDelete);
    };
}

interface FluxerMessageLike {
    readonly id: string;
    readonly channelId: string;
    readonly channel: unknown;
    readonly webhookId?: string | null;
    readonly type?: number;
    readonly partial?: boolean;
    readonly author?: { readonly id: string } | null;
    readonly content?: string | null;
}

function fluxerEvent(message: FluxerMessageLike): ThreadMessageEvent | null {
    const channel = message.channel;
    if (!(channel instanceof ThreadChannel)) return null;
    return {
        id: message.id,
        channelId: message.channelId,
        parentId: channel.parentId,
        webhookId: message.webhookId ?? null,
    };
}

/** Listens on one Fluxer client. Returns a function that stops it. */
export function listenToFluxerThreads(
    client: FluxerClient,
    relay: ThreadRelay,
    wrap: Wrap,
    prefix: string = upstreamCommandPrefix()
): () => void {
    const onCreate = wrap(
        'thread-message',
        async (message: FluxerMessageLike) => {
            const event = fluxerEvent(message);
            if (!event || message.author?.id === client.user?.id) return;
            const type = Number(message.type ?? FLUXER_DEFAULT_TYPE);
            if (type !== FLUXER_DEFAULT_TYPE && type !== FLUXER_REPLY_TYPE)
                return;
            if (isCommandMessage(message.content, prefix)) return;
            await relay.created('fluxer', event, message);
        }
    );
    const onUpdate = wrap(
        'thread-edit',
        async (_old: unknown, next: FluxerMessageLike) => {
            const event = fluxerEvent(next);
            if (!event || next.partial) return;
            await relay.edited('fluxer', event, next);
        }
    );
    const onDelete = wrap(
        'thread-delete',
        async (message: FluxerMessageLike) => {
            const event = fluxerEvent(message);
            if (event) await relay.deleted('fluxer', event.id, event.parentId);
        }
    );
    client.on(FluxerEvents.MessageCreate, onCreate);
    client.on(FluxerEvents.MessageUpdate, onUpdate);
    client.on(FluxerEvents.MessageDelete, onDelete);
    return () => {
        client.off(FluxerEvents.MessageCreate, onCreate);
        client.off(FluxerEvents.MessageUpdate, onUpdate);
        client.off(FluxerEvents.MessageDelete, onDelete);
    };
}

/** How often the Fluxer client is checked for a replacement. */
export const FLUXER_WATCH_MS = 15_000;

/**
 * Upstream replaces the Fluxer client when it restarts the connection, and
 * listeners do not move with it. This re-attaches them to the new client.
 * Returns a function that stops watching and detaches.
 */
export function followFluxerClient(
    ref: { readonly current: FluxerClient | null },
    attach: (client: FluxerClient) => () => void
): () => void {
    let attached: FluxerClient | null = null;
    let detach: (() => void) | null = null;
    const check = () => {
        if (ref.current === attached) return;
        detach?.();
        attached = ref.current;
        detach = attached ? attach(attached) : null;
    };
    check();
    const timer = setInterval(check, FLUXER_WATCH_MS);
    return () => {
        clearInterval(timer);
        detach?.();
    };
}

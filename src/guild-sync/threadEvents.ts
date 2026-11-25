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
import { isContentEdit, type EditView } from '../relay-extras/edits';
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

/**
 * Listens on the Discord client and retries the relay's parked replies
 * meanwhile. Returns a function that stops both.
 */
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
            old: Message | PartialMessage,
            next: Message | PartialMessage
        ) => {
            const event = discordEvent(next);
            if (!event || next.partial) return;
            // A pin or link preview is not an edit (relay-extras/edits.ts).
            if (!isContentEdit(old, next, Date.now())) return;
            await relay.edited('discord', event, next);
        }
    );
    const onDelete = wrap(
        'thread-delete',
        async (message: Message | PartialMessage) => {
            const event = discordEvent(message);
            if (!event) return;
            await relay.deleted(
                'discord',
                event.id,
                event.parentId,
                event.channelId
            );
        }
    );
    client.on(Events.MessageCreate, onCreate);
    client.on(Events.MessageUpdate, onUpdate);
    client.on(Events.MessageDelete, onDelete);
    // Parked replies are retried while the relay listens.
    const flush = wrap('thread-flush', (pass: () => Promise<void>) => pass());
    relay.startFlushing(flush);
    return () => {
        relay.stopFlushing();
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
    readonly editedAt?: Date | null;
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
        async (old: EditView | null, next: FluxerMessageLike) => {
            const event = fluxerEvent(next);
            if (!event || next.partial) return;
            if (!isContentEdit(old, next, Date.now())) return;
            await relay.edited('fluxer', event, next);
        }
    );
    const onDelete = wrap(
        'thread-delete',
        async (message: FluxerMessageLike) => {
            const event = fluxerEvent(message);
            if (!event) return;
            await relay.deleted(
                'fluxer',
                event.id,
                event.parentId,
                event.channelId
            );
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

/** How often the Fluxer client is checked as a safety net. */
export const FLUXER_WATCH_MS = 15_000;
/** How often it is checked when assignments cannot be observed. */
export const FLUXER_FALLBACK_WATCH_MS = 1_000;

type ClientRef = { readonly current: FluxerClient | null };

/** Callbacks run when upstream assigns `current`, per observed ref. */
const refWatchers = new WeakMap<object, Set<() => void>>();

function notify(watchers: ReadonlySet<() => void>): void {
    for (const watcher of [...watchers]) {
        // Upstream assigns the ref inside its restart code; nothing the
        // add-ons do there may throw into it.
        try {
            watcher();
        } catch {
            // The safety poll retries the attach.
        }
    }
}

/** Replaces the data property `current` with an accessor that notifies. */
function makeObservable(ref: object): Set<() => void> | null {
    const own = Object.getOwnPropertyDescriptor(ref, 'current');
    if (!own || !own.configurable || !own.writable) return null;
    const watchers = new Set<() => void>();
    let value: unknown = own.value;
    Object.defineProperty(ref, 'current', {
        configurable: true,
        enumerable: own.enumerable,
        get: () => value,
        set: (next: unknown) => {
            value = next;
            notify(watchers);
        },
    });
    refWatchers.set(ref, watchers);
    return watchers;
}

/**
 * Calls `onChange` right after each assignment to `ref.current`. Reads and
 * writes behave as before for upstream. Returns a function that stops it,
 * or null when the property cannot be observed.
 */
export function observeClientRef(
    ref: ClientRef,
    onChange: () => void
): (() => void) | null {
    const watchers = refWatchers.get(ref) ?? makeObservable(ref);
    if (!watchers) return null;
    watchers.add(onChange);
    return () => {
        watchers.delete(onChange);
    };
}

/**
 * Upstream replaces the Fluxer client when it restarts the connection, and
 * listeners do not move with it. This re-attaches them to the new client
 * as soon as upstream assigns it to the ref, with a slow poll as a safety
 * net (a fast one when the ref cannot be observed). Returns a function
 * that stops watching and detaches.
 */
export function followFluxerClient(
    ref: ClientRef,
    attach: (client: FluxerClient) => () => void
): () => void {
    let attached: FluxerClient | null = null;
    let detach: (() => void) | null = null;
    const check = () => {
        const next = ref.current;
        if (next === attached) return;
        detach?.();
        detach = null;
        attached = null;
        // Set only after a successful attach, so a failed one is retried.
        if (next) detach = attach(next);
        attached = next;
    };
    check();
    const unobserve = observeClientRef(ref, check);
    const every = unobserve ? FLUXER_WATCH_MS : FLUXER_FALLBACK_WATCH_MS;
    const timer = setInterval(check, every);
    return () => {
        clearInterval(timer);
        unobserve?.();
        detach?.();
        detach = null;
    };
}

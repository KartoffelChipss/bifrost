import {
    Events,
    type Client as DiscordClient,
    type Message,
    type PartialMessage,
    type ReadonlyCollection,
} from 'discord.js';
import type { HistoryMirror } from './mirror';

type Wrap = <A extends unknown[]>(
    task: string,
    fn: (...args: A) => Promise<void> | void
) => (...args: A) => void;

type AnyMessage = Message | PartialMessage;

/** The edited message, or null for an update that is not an edit. */
async function editedMessage(message: AnyMessage): Promise<Message | null> {
    const full = message.partial ? await message.fetch() : message;
    // Link previews and pins update a message too, without editing it.
    return full.editedTimestamp ? full : null;
}

/**
 * Feeds Discord edits and deletes to the history mirror. Returns a
 * function that stops listening.
 */
export function listenToDiscordEdits(
    client: DiscordClient,
    mirror: HistoryMirror,
    wrap: Wrap
): () => void {
    const onUpdate = wrap(
        'mirror-edit',
        async (_old: AnyMessage, next: AnyMessage) => {
            if (!next.guildId) return;
            await mirror.edited(next.id, () => editedMessage(next));
        }
    );
    const onDelete = wrap('mirror-delete', async (message: AnyMessage) => {
        if (message.guildId) await mirror.deleted(message.id);
    });
    const onBulkDelete = wrap(
        'mirror-delete',
        async (messages: ReadonlyCollection<string, AnyMessage>) => {
            // Discord deletes at most 100 messages in one bulk delete.
            for (const id of messages.keys()) await mirror.deleted(id);
        }
    );
    client.on(Events.MessageUpdate, onUpdate);
    client.on(Events.MessageDelete, onDelete);
    client.on(Events.MessageBulkDelete, onBulkDelete);
    return () => {
        client.off(Events.MessageUpdate, onUpdate);
        client.off(Events.MessageDelete, onDelete);
        client.off(Events.MessageBulkDelete, onBulkDelete);
    };
}

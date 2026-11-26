import {
    Events,
    type Client as DiscordClient,
    type Message,
    type PartialMessage,
    type ReadonlyCollection,
} from 'discord.js';
import type { ArchiveUpkeep } from './upkeep';

type Wrap = <A extends unknown[]>(
    task: string,
    fn: (...args: A) => Promise<void> | void
) => (...args: A) => void;

type AnyMessage = Message | PartialMessage;

/**
 * Keeps archived messages in step with Discord: an edit is stored again,
 * a delete removes the message and files only it used. New messages come
 * in through the walk's catch-up. Returns a function that stops listening.
 */
export function listenToArchiveEdits(
    client: DiscordClient,
    upkeep: Pick<ArchiveUpkeep, 'edited' | 'deleted'>,
    wrap: Wrap
): () => void {
    const onUpdate = wrap(
        'archive-edit',
        async (_old: AnyMessage, next: AnyMessage) => {
            if (!next.guildId) return;
            await upkeep.edited(next.guildId, next.channelId, next.id);
        }
    );
    const onDelete = wrap('archive-delete', async (message: AnyMessage) => {
        if (message.guildId) await upkeep.deleted(message.id);
    });
    const onBulkDelete = wrap(
        'archive-delete',
        async (messages: ReadonlyCollection<string, AnyMessage>) => {
            // Discord deletes at most 100 messages in one bulk delete.
            for (const id of messages.keys()) await upkeep.deleted(id);
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

import { Routes, type Client as DiscordClient } from 'discord.js';
import { isNotFound } from '../guild-sync/notFound';
import type { ArchiveSource } from './types';

/**
 * Discord's REST API through discord.js's client. Its REST manager keeps
 * to Discord's rate limits: it queues requests per route bucket, waits out
 * a 429's retry-after, and retries server errors. Responses are the raw
 * API objects, which the archive stores as they are.
 */
export function discordArchiveSource(client: DiscordClient): ArchiveSource {
    return {
        async page(channelId, afterId, limit) {
            const query = new URLSearchParams({
                after: afterId,
                limit: String(limit),
            });
            const result = await client.rest.get(
                Routes.channelMessages(channelId),
                { query }
            );
            return Array.isArray(result) ? (result as unknown[]) : [];
        },
        message: (channelId, messageId) =>
            orNull(() =>
                client.rest.get(Routes.channelMessage(channelId, messageId))
            ),
        member: (guildId, userId) =>
            orNull(() => client.rest.get(Routes.guildMember(guildId, userId))),
    };
}

/** The result, or null when Discord says it does not exist. */
async function orNull(get: () => Promise<unknown>): Promise<unknown | null> {
    try {
        return await get();
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

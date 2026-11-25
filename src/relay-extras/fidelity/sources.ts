import type { Message as FluxerMessage } from '@fluxerjs/core';
import type { Message as DiscordMessage } from 'discord.js';
import type { SourceFacts } from './types';

/**
 * Reads the facts fidelity needs from a platform message. Pure, so tests
 * pass plain objects shaped like the platform message.
 */

export type DiscordSource = Pick<
    DiscordMessage,
    'guildId' | 'channelId' | 'content'
>;

export type FluxerSource = Pick<
    FluxerMessage,
    'guildId' | 'channelId' | 'content'
>;

export function discordFacts(message: DiscordSource): SourceFacts {
    return {
        side: 'discord',
        guildId: message.guildId,
        channelId: message.channelId,
        content: message.content ?? '',
    };
}

export function fluxerFacts(message: FluxerSource): SourceFacts {
    return {
        side: 'fluxer',
        guildId: message.guildId,
        channelId: message.channelId,
        content: message.content ?? '',
    };
}

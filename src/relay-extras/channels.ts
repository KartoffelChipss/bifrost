import { TextChannel, VoiceChannel } from '@fluxerjs/core';

/** The channel kind checks discord.js channels answer. */
export interface DiscordChannelKinds {
    isTextBased(): boolean;
    isDMBased(): boolean;
    isThread(): boolean;
}

/**
 * True for a Discord channel whose messages upstream's relay copies: text,
 * announcement, voice and stage chat. Threads are left to guild-sync's
 * thread relay, so upstream must keep skipping them.
 */
export function isRelayedDiscordChannel(channel: DiscordChannelKinds): boolean {
    return channel.isTextBased() && !channel.isDMBased() && !channel.isThread();
}

/**
 * True for a Fluxer channel whose messages upstream's relay copies. An
 * announcement channel is a TextChannel; a voice channel is not, though its
 * chat works the same. Threads are neither.
 */
export function isRelayedFluxerChannel(
    channel: unknown
): channel is TextChannel | VoiceChannel {
    return channel instanceof TextChannel || channel instanceof VoiceChannel;
}

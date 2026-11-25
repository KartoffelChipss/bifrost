import type { ThreadMessage } from '../guild-sync/store';
import type { MessagePair, Side } from './types';

/**
 * Finds the counterpart of a relayed message. Upstream records messages of
 * bridged channels in message_links; guild-sync records messages of synced
 * threads and forum posts in addon_thread_messages.
 */
export interface PairSources {
    bridgedMessage(side: Side, messageId: string): Promise<MessagePair | null>;
    threadMessage(side: Side, messageId: string): Promise<ThreadMessage | null>;
}

export function threadPair(message: ThreadMessage): MessagePair {
    return {
        guildLinkId: message.guildLinkId,
        discord: {
            channelId: message.discordThreadId,
            messageId: message.discordMessageId,
        },
        fluxer: {
            channelId: message.fluxerThreadId,
            messageId: message.fluxerMessageId,
        },
    };
}

export type FindPair = (
    side: Side,
    messageId: string
) => Promise<MessagePair | null>;

export function pairFinder(sources: PairSources): FindPair {
    return async (side, messageId) => {
        const bridged = await sources.bridgedMessage(side, messageId);
        if (bridged) return bridged;
        const thread = await sources.threadMessage(side, messageId);
        return thread ? threadPair(thread) : null;
    };
}

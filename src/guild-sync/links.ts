import type { WebhookMessageData } from '../services/WebhookService';

/**
 * The seams between guild-sync and Bifröst's relay: channel links with
 * their webhooks, and the first message of a thread or forum post. The
 * implementations (upstreamBridge.ts) call upstream's services.
 */

/** What the relay sends through a webhook: text, author name and avatar. */
export type RelayPayload = WebhookMessageData;

export interface WebhookRef {
    readonly id: string;
    readonly token: string;
}

/** One bridged channel pair, as upstream's `channel_links` stores it. */
export interface LinkedChannel {
    readonly id: string;
    readonly guildLinkId: string;
    readonly discordChannelId: string;
    readonly fluxerChannelId: string;
    readonly discordWebhook: WebhookRef;
    readonly fluxerWebhook: WebhookRef;
}

export interface ChannelLinker {
    /** Discord channel IDs that are bridged on this guild link. */
    linkedDiscordChannels(discordGuildId: string): Promise<Set<string>>;
    /** Creates a webhook on both channels and bridges the pair. */
    link(
        guildLinkId: string,
        discordChannelId: string,
        fluxerChannelId: string
    ): Promise<void>;
    /** Removes the bridge and both webhooks. Does nothing when unlinked. */
    unlink(discordChannelId: string): Promise<void>;
    byDiscordChannel(discordChannelId: string): Promise<LinkedChannel | null>;
    byFluxerChannel(fluxerChannelId: string): Promise<LinkedChannel | null>;
}

/** Reads what a thread needs from the source besides its structure. */
export interface ThreadSource {
    /**
     * The first message of a thread or forum post, ready for a webhook.
     * Returns a placeholder when the message was deleted.
     */
    starter(guildId: string, threadId: string): Promise<RelayPayload>;
}

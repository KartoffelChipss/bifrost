import type { SnapshotSide } from '../addons/db/schema';
import type { AddonLogger } from '../addons/isolation';

/**
 * Live reactions and pins for relayed messages. Upstream Bifröst relays
 * message text only; this module mirrors what people do to a message after
 * it was relayed.
 */

export type Side = SnapshotSide;

export const otherSide = (side: Side): Side =>
    side === 'discord' ? 'fluxer' : 'discord';

/** One message on one platform. */
export interface MessageRef {
    readonly channelId: string;
    readonly messageId: string;
}

/** The two copies of one relayed message. */
export interface MessagePair {
    readonly guildLinkId: string;
    readonly discord: MessageRef;
    readonly fluxer: MessageRef;
}

/** A reaction emoji. `id` is null for a unicode emoji. */
export interface ReactionEmoji {
    readonly id: string | null;
    readonly name: string;
    readonly animated: boolean;
}

/**
 * Lookups in upstream's data, implemented by the ReactionPorts section of
 * src/guild-sync/upstreamBridge.ts.
 */
export interface RelayLookupPorts {
    /** The message_links pair of a message relayed in a bridged channel. */
    bridgedMessage(side: Side, messageId: string): Promise<MessagePair | null>;
    /** A custom emoji of the guild link's server on `side`, if it is there. */
    guildEmoji(
        side: Side,
        guildLinkId: string,
        emojiId: string
    ): Promise<ReactionEmoji | null>;
}

/** Runs work so a failure is logged as a warning and never escapes. */
export async function guarded(
    logger: AddonLogger,
    what: string,
    work: () => Promise<void>
): Promise<void> {
    try {
        await work();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(`[relay-extras] ${what}: ${detail}`);
    }
}

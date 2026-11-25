import type { AddonLogger } from '../../addons/isolation';
import type WebhookEmbed from '../../services/WebhookEmbed';
import type {
    WebhookAttachment,
    WebhookMessageData,
} from '../../services/WebhookService';
import type { MapRow } from '../../guild-sync/ops';
import type { FindPair } from '../pairs';
import type { Side } from '../types';

/**
 * Message fidelity: relayed copies that look like the source message on
 * the other platform. Upstream Bifröst flattens mentions to text and posts
 * every copy under the author's global username. This module maps
 * mentions, emojis, pings, names, replies and stickers to the other
 * platform through the fork's ID maps: channel links, guild-sync's object
 * map, linked accounts and message pairs.
 */

export type { Side };

/** Who a copy may ping, as IDs on the target platform. */
export interface PingSpec {
    readonly everyone: boolean;
    readonly users: readonly string[];
    readonly roles: readonly string[];
    /** The author of the message a native reply answers. */
    readonly repliedUser: boolean;
}

/** A message on the target platform. */
export interface TargetMessageRef {
    readonly channelId: string;
    readonly messageId: string;
}

/**
 * Fork fields on a webhook payload. Plain JSON, so upstream's retry queue
 * (MessageQueueService.toSerializable) keeps them.
 */
export interface CopyFidelity {
    readonly pings?: PingSpec;
    /** The counterpart this copy replies to. Fluxer webhooks only. */
    readonly replyTo?: TargetMessageRef;
    /**
     * Upstream's quote embed that `replyTo` replaces, for a copy that
     * cannot reply natively: a rejected send, or an edit of a copy that
     * was first sent with the quote. Set only with `replyTo`.
     */
    readonly replyQuote?: PlainEmbed;
    /** Synced stickers on the target side. Fluxer webhooks only, max 3. */
    readonly stickerIds?: readonly string[];
    /**
     * Upstream's sticker images that `stickerIds` replaces, in their
     * place at the end of the attachments. Set only with `stickerIds`.
     */
    readonly stickerImages?: readonly WebhookAttachment[];
}

/** A WebhookEmbed as plain JSON, as the retry queue stores embeds. */
export type PlainEmbed = ReturnType<WebhookEmbed['toPlainObject']>;

/** What the source message really pinged, as source IDs. */
export interface SourcePings {
    readonly users: readonly string[];
    readonly roles: readonly string[];
    readonly everyone: boolean;
}

/** How the author appears in the source server. */
export interface SourceAuthor {
    /** Server nickname, else global display name; null to keep upstream's. */
    readonly displayName: string | null;
    /** Server avatar; null to keep upstream's global avatar. */
    readonly avatarUrl: string | null;
}

/** The parts of a source message fidelity reads, from either platform. */
export interface SourceFacts {
    readonly side: Side;
    readonly guildId: string | null;
    readonly channelId: string;
    readonly content: string;
    readonly pinged: SourcePings;
    readonly author: SourceAuthor;
    /** The message this one replies to, on the source side. */
    readonly reply: SourceReply | null;
    readonly stickers: readonly SourceSticker[];
}

/** A sticker on the source message. */
export interface SourceSticker {
    readonly id: string;
    /** The image URL upstream's transformer attaches for it. */
    readonly url: string;
}

/** A source reply: the message it answers, and whether it pinged. */
export interface SourceReply {
    readonly messageId: string;
    readonly pinged: boolean;
}

/** One upstream guild link. */
export interface GuildLinkRef {
    readonly id: string;
    readonly discordGuildId: string;
    readonly fluxerGuildId: string;
}

/** One upstream channel link. */
export interface ChannelLinkRef {
    readonly guildLinkId: string;
    readonly discordChannelId: string;
    readonly fluxerChannelId: string;
}

/** A linked account pair (addon_identity_links). */
export interface AccountPair {
    readonly discordUserId: string;
    readonly fluxerUserId: string;
}

/** What fidelity reads from the database and the platforms. */
export interface FidelityPorts {
    listGuildLinks(): Promise<readonly GuildLinkRef[]>;
    /** guild-sync's addon_object_map rows for one guild link. */
    loadObjectMap(guildLinkId: string): Promise<readonly MapRow[]>;
    listAccountPairs(): Promise<readonly AccountPair[]>;
    channelLink(side: Side, channelId: string): Promise<ChannelLinkRef | null>;
    findPair: FindPair;
    /** False when the message is gone; other errors propagate. */
    messageExists(
        side: Side,
        channelId: string,
        messageId: string
    ): Promise<boolean>;
    /** The IDs of the stickers a server has. */
    guildStickerIds(side: Side, guildId: string): Promise<ReadonlySet<string>>;
    now(): number;
    readonly logger: AddonLogger;
}

/**
 * What a transformer asks while it builds one copy. Every method is
 * synchronous: the service looks everything up before the transform.
 */
export interface FidelityView {
    /** The target-side form of a mention token, or null to flatten it. */
    readonly mention: (token: string) => string | null;
    /** Replaces source custom emojis with their synced target emojis. */
    emojis(content: string, targetEmojis: readonly TargetEmoji[]): string;
    /** Upstream's breakMentions, sparing mentions that may ping. */
    breakMentions(content: string): string;
    /** The copy is a native reply, so upstream's quote embed is left out. */
    readonly nativeReply: boolean;
    /**
     * Adds the fork fields to a finished payload. `replyQuote` is the
     * quote embed a native reply leaves out, kept for a fallback.
     */
    finish(
        payload: WebhookMessageData,
        replyQuote?: WebhookEmbed | null
    ): WebhookMessageData;
}

/** A custom emoji of the target server, as upstream's resolvers list it. */
export interface TargetEmoji {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
}

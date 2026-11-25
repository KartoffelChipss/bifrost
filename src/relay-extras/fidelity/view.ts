import type WebhookEmbed from '../../services/WebhookEmbed';
import type {
    WebhookAttachment,
    WebhookMessageData,
} from '../../services/WebhookService';
import { breakMentions } from '../../utils/sanitizeMentions';
import {
    breakUnpinged,
    mapEmojis,
    mapMentionToken,
    type MentionMaps,
} from './mentions';
import { webhookName } from './profile';
import type { StickerSwap } from './stickers';
import type {
    FidelityView,
    PingSpec,
    Side,
    SourceFacts,
    TargetMessageRef,
} from './types';

/** A copy that pings nobody. */
export const NO_PINGS: PingSpec = {
    everyone: false,
    users: [],
    roles: [],
    repliedUser: false,
};

/** Everything the service looked up for one source message. */
export interface Resolution {
    readonly facts: SourceFacts;
    readonly target: Side;
    readonly mentions: MentionMaps;
    readonly emojis: ReadonlyMap<string, string>;
    /** The counterpart a native reply answers, when it can be one. */
    readonly replyTo: TargetMessageRef | null;
    readonly stickers: StickerSwap;
}

/** Upstream's behaviour: flat mentions, upstream's payload unchanged. */
export const NO_FIDELITY: FidelityView = {
    mention: () => null,
    emojis: (content) => content,
    breakMentions,
    nativeReply: false,
    finish: (payload) => payload,
};

/** Target IDs of the mapped source IDs, without repeats. */
function mapIds(
    ids: readonly string[],
    map: ReadonlyMap<string, string>
): string[] {
    const out = new Set<string>();
    for (const id of ids) {
        const target = map.get(id);
        if (target) out.add(target);
    }
    return [...out];
}

/**
 * What the copy may ping: exactly what the source pinged, where it maps.
 * A user who did not link accounts, or a role guild-sync did not sync, is
 * plain text on the copy and cannot ping.
 */
export function copyPings(resolution: Resolution): PingSpec {
    const { pinged } = resolution.facts;
    return {
        everyone: pinged.everyone,
        users: mapIds(pinged.users, resolution.mentions.users),
        roles: mapIds(pinged.roles, resolution.mentions.roles),
        repliedUser: resolution.replyTo
            ? resolution.facts.reply?.pinged === true
            : false,
    };
}

/**
 * The copy goes out under the author's server name and avatar where the
 * target accepts them, and with the pings it may make.
 */
function finishWith(
    payload: WebhookMessageData,
    resolution: Resolution,
    pings: PingSpec,
    replyQuote: WebhookEmbed | null
): WebhookMessageData {
    const { author } = resolution.facts;
    const { ids, replacedUrls } = resolution.stickers;
    const replaced = (attachment: WebhookAttachment) =>
        replacedUrls.has(attachment.url);
    const images = payload.attachments?.filter(replaced) ?? [];
    return {
        ...payload,
        attachments: payload.attachments?.filter((a) => !replaced(a)),
        username:
            webhookName(author.displayName, resolution.target) ??
            payload.username,
        avatarURL: author.avatarUrl || payload.avatarURL,
        fidelity: {
            ...payload.fidelity,
            pings,
            ...replyFields(resolution.replyTo, replyQuote),
            ...(ids.length > 0
                ? { stickerIds: ids, stickerImages: images }
                : {}),
        },
    };
}

/** A native reply, with the quote it replaces kept for a fallback. */
function replyFields(
    replyTo: TargetMessageRef | null,
    replyQuote: WebhookEmbed | null
) {
    if (!replyTo) return {};
    return replyQuote
        ? { replyTo, replyQuote: replyQuote.toPlainObject() }
        : { replyTo };
}

/** The view a transformer reads while it builds one copy. */
export function createView(resolution: Resolution): FidelityView {
    const pings = copyPings(resolution);
    return {
        mention: (token) => mapMentionToken(token, resolution.mentions),
        emojis: (content, targetEmojis) =>
            mapEmojis(content, resolution.emojis, targetEmojis),
        breakMentions: (content) => breakUnpinged(content, pings.everyone),
        nativeReply: resolution.replyTo !== null,
        finish: (payload, replyQuote) =>
            finishWith(payload, resolution, pings, replyQuote ?? null),
    };
}

/**
 * Upstream's formatting with explicit pings, for a copy fidelity could
 * not resolve. Without them a Fluxer webhook parses every `@everyone`
 * and `@here` in the text (MessageMentionService.extractMentions defaults
 * canMentionEveryone to true), so a Discord member who may not mention
 * everyone could ping a whole Fluxer server.
 */
export function plainView(pings: PingSpec): FidelityView {
    return {
        ...NO_FIDELITY,
        finish: (payload) => ({
            ...payload,
            fidelity: { ...payload.fidelity, pings },
        }),
    };
}

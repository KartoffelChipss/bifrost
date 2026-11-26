import WebhookEmbed from '../../services/WebhookEmbed';
import type { WebhookMessageData } from '../../services/WebhookService';

/**
 * Fork: a Fluxer copy whose embeds Fluxer cannot process. Fluxer fetches
 * embed images through its media and unfurl services, and answers 503
 * when it cannot (NatsUnfurlerService, AttachmentUploadService). After a
 * 503 the same copy is tried once more; if Fluxer refuses it again, it
 * is sent without its embed images, then without its embeds, so the rest
 * of the message still arrives. A real outage refuses every attempt, and
 * the copy is then kept whole (WebhookService) for the queue.
 */

export type EmbedFallback = 'retry' | 'embedImages' | 'embeds';

/** Each step is tried once per send. */
export const MAX_EMBED_FALLBACKS = 3;
/** The pause before the same copy is tried again after a 503. */
export const EMBED_RETRY_DELAY_MS = 1_000;

/** Fluxer's 503: a service behind the API could not do its part. */
function isUnavailable(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    return (error as { statusCode?: unknown }).statusCode === 503;
}

type PlainEmbed = ReturnType<WebhookEmbed['toPlainObject']>;

function hasMedia(embed: PlainEmbed): boolean {
    return Boolean(
        embed.image?.url ||
        embed.thumbnail?.url ||
        embed.footer?.iconURL ||
        embed.author?.iconURL
    );
}

/**
 * The next embed fallback for a failed send, or null: only after a 503,
 * only for a copy with embeds, and each fallback once.
 */
export function embedFallback(
    error: unknown,
    data: WebhookMessageData,
    tried: ReadonlySet<EmbedFallback>
): EmbedFallback | null {
    if (!isUnavailable(error) || !data.embeds?.length) return null;
    if (!tried.has('retry')) return 'retry';
    const plain = data.embeds.map((e) => e.toPlainObject());
    if (!tried.has('embedImages') && plain.some(hasMedia)) {
        return 'embedImages';
    }
    return tried.has('embeds') ? null : 'embeds';
}

function withoutMedia(embed: PlainEmbed): PlainEmbed {
    return {
        ...embed,
        image: null,
        thumbnail: null,
        footer: embed.footer ? { ...embed.footer, iconURL: undefined } : null,
        author: embed.author ? { ...embed.author, iconURL: undefined } : null,
    };
}

/** The copy without the embed images, or without its embeds. */
export function withoutEmbedPart(
    data: WebhookMessageData,
    fallback: EmbedFallback
): WebhookMessageData {
    if (fallback === 'retry') return data;
    if (fallback === 'embeds') return { ...data, embeds: [] };
    return {
        ...data,
        embeds: data.embeds?.map((e) =>
            WebhookEmbed.fromPlainObject(withoutMedia(e.toPlainObject()))
        ),
    };
}

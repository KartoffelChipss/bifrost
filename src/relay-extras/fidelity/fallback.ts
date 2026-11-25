import WebhookEmbed from '../../services/WebhookEmbed';
import type {
    WebhookAttachment,
    WebhookMessageData,
} from '../../services/WebhookService';
import type { CopyFidelity, PlainEmbed } from './types';

/**
 * Upstream's rendering for a Fluxer copy that cannot carry a native reply
 * or sticker. Fluxer rejects the whole send when the replied-to message is
 * gone or a sticker is unknown, and a webhook edit can neither add nor
 * drop a message_reference or a sticker.
 */

/** A fork field Fluxer can reject on its own. */
export type RejectedField = 'replyTo' | 'stickerIds';

/** Each fallback drops one field, so a send needs at most this many. */
export const MAX_FALLBACKS = 2;

/** Upper bound on the validation errors read from one response. */
const MAX_ERROR_ENTRIES = 50;

interface ApiErrorShape {
    readonly statusCode?: unknown;
    readonly code?: unknown;
    readonly errors?: unknown;
}

/**
 * A 4xx other than 429. `@fluxerjs/rest` throws FluxerAPIError with the
 * response's `code`, `statusCode` and `errors` (request-manager.js).
 */
function clientError(error: unknown): ApiErrorShape | null {
    if (typeof error !== 'object' || error === null) return null;
    const { statusCode } = error as ApiErrorShape;
    if (typeof statusCode !== 'number') return null;
    if (statusCode < 400 || statusCode >= 500 || statusCode === 429) {
        return null;
    }
    return error as ApiErrorShape;
}

/** The `path` of each INVALID_FORM_BODY entry (InputValidationError). */
function errorPaths(error: ApiErrorShape): string[] {
    if (error.code !== 'INVALID_FORM_BODY') return [];
    if (!Array.isArray(error.errors)) return [];
    const paths: string[] = [];
    for (const entry of error.errors.slice(0, MAX_ERROR_ENTRIES)) {
        const path = (entry as { path?: unknown } | null)?.path;
        if (typeof path === 'string') paths.push(path);
    }
    return paths;
}

const under = (path: string, field: string) =>
    path === field || path.startsWith(`${field}.`);

/**
 * Fluxer's webhook send throws UnknownMessageError (404 UNKNOWN_MESSAGE)
 * for a missing reply target, and INVALID_FORM_BODY at
 * `message_reference` for a system message (MessageSendService
 * sendWebhookMessage).
 */
function rejectsReply(error: ApiErrorShape): boolean {
    if (error.code === 'UNKNOWN_MESSAGE') return true;
    return errorPaths(error).some((path) => under(path, 'message_reference'));
}

/**
 * Fluxer rejects an unknown or foreign sticker with INVALID_FORM_BODY at
 * `sticker` (MessageStickerService.computeStickerIds), and a malformed
 * list at `sticker_ids` (schema validation).
 */
function rejectsStickers(error: ApiErrorShape): boolean {
    return errorPaths(error).some(
        (path) => path === 'sticker' || under(path, 'sticker_ids')
    );
}

/**
 * The fork field a failed Fluxer send was rejected for, or null when the
 * failure is not about one: a 5xx, a network error, or another 4xx.
 */
export function rejectedField(
    error: unknown,
    fidelity: CopyFidelity | undefined
): RejectedField | null {
    const rejection = clientError(error);
    if (!rejection || !fidelity) return null;
    if (fidelity.replyTo && rejectsReply(rejection)) return 'replyTo';
    if (fidelity.stickerIds?.length && rejectsStickers(rejection)) {
        return 'stickerIds';
    }
    return null;
}

function withQuote(
    embeds: WebhookEmbed[] | undefined,
    quote: PlainEmbed | undefined
): WebhookEmbed[] | undefined {
    if (!quote) return embeds;
    return [WebhookEmbed.fromPlainObject(quote), ...(embeds ?? [])];
}

function withImages(
    attachments: WebhookAttachment[] | undefined,
    images: readonly WebhookAttachment[] | undefined
): WebhookAttachment[] | undefined {
    if (!images?.length) return attachments;
    return [...(attachments ?? []), ...images];
}

/** The payload without the native reply, with upstream's quote back. */
function withoutReply(data: WebhookMessageData): WebhookMessageData {
    const fidelity = data.fidelity ?? {};
    const pings = fidelity.pings
        ? { ...fidelity.pings, repliedUser: false }
        : undefined;
    return {
        ...data,
        embeds: withQuote(data.embeds, fidelity.replyQuote),
        fidelity: {
            ...(pings ? { pings } : {}),
            ...(fidelity.stickerIds ? { stickerIds: fidelity.stickerIds } : {}),
            ...(fidelity.stickerImages
                ? { stickerImages: fidelity.stickerImages }
                : {}),
        },
    };
}

/** The payload without native stickers, with upstream's images back. */
function withoutStickers(data: WebhookMessageData): WebhookMessageData {
    const fidelity = data.fidelity ?? {};
    return {
        ...data,
        attachments: withImages(data.attachments, fidelity.stickerImages),
        fidelity: {
            ...(fidelity.pings ? { pings: fidelity.pings } : {}),
            ...(fidelity.replyTo ? { replyTo: fidelity.replyTo } : {}),
            ...(fidelity.replyQuote ? { replyQuote: fidelity.replyQuote } : {}),
        },
    };
}

/** The payload rendered without the field Fluxer rejected. */
export function withoutField(
    data: WebhookMessageData,
    field: RejectedField
): WebhookMessageData {
    return field === 'replyTo' ? withoutReply(data) : withoutStickers(data);
}

/**
 * Whether an edit must look at the copy first: only a native reply's
 * payload leaves out a quote the copy may carry.
 */
export function editNeedsCopy(data: WebhookMessageData): boolean {
    return data.fidelity?.replyQuote !== undefined;
}

/** Whether a Fluxer message, as the API returns it, is a reply. */
export function repliesNatively(copy: unknown): boolean {
    if (typeof copy !== 'object' || copy === null) return false;
    const reference = (copy as { message_reference?: unknown })
        .message_reference;
    return typeof reference === 'object' && reference !== null;
}

/**
 * The payload of a Fluxer edit, which keeps the rendering the copy was
 * sent with. The quote stays unless the copy is a native reply. Sticker
 * images stay in their place: Fluxer keeps an edit's existing attachment
 * by its index and drops an index the copy does not have
 * (MessagePersistenceService.resolveExistingAttachment), so a copy sent
 * with native stickers loses nothing it showed.
 */
export function editPayload(
    data: WebhookMessageData,
    copyReplies: boolean
): WebhookMessageData {
    const fidelity = data.fidelity;
    return {
        ...data,
        embeds: copyReplies
            ? data.embeds
            : withQuote(data.embeds, fidelity?.replyQuote),
        attachments: withImages(data.attachments, fidelity?.stickerImages),
    };
}

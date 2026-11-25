/**
 * Sorts errors from a history send into ones worth retrying later, upload
 * refusals, and the rest. Both platforms' REST errors carry an HTTP
 * status: `statusCode` on @fluxerjs/rest's FluxerAPIError and HTTPError,
 * `status` on discord.js's DiscordAPIError and HTTPError.
 */

/** Failed while copying one message; `cause` is what went wrong. */
export class MessageError extends Error {
    constructor(
        readonly messageId: string,
        readonly cause: unknown
    ) {
        super(describeError(cause));
    }
}

/** Socket and DNS failures from Node and undici, all temporary. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
]);

const TRANSIENT_TEXT =
    /gateway is not ready|timed? ?out|socket hang up|fetch failed|service unavailable|bad gateway/i;

/**
 * Client-side and server-side upload refusals. Fluxer answers 413 with
 * FILE_SIZE_TOO_LARGE (fluxer errors RequestBodyTooLargeError) and 400 with
 * the same code (FileSizeTooLargeError); @fluxerjs/util ErrorCodes names
 * the client's own file failures.
 */
const UPLOAD_CODES: ReadonlySet<string> = new Set([
    'FILE_SIZE_TOO_LARGE',
    'ATTACHMENT_TOO_LARGE',
    'FILE_FETCH_FAILED',
    'INVALID_FILE_URL',
    'INVALID_ATTACHMENT',
    'INVALID_ATTACHMENT_INPUT',
    'ATTACHMENT_FILENAME_REQUIRED',
    'NO_FILE_FOR_ATTACHMENT',
    'NO_FILE_FOR_ATTACHMENT_METADATA',
]);

/**
 * Error codes that blame the target, not the message: the webhook, the
 * channel or the guild is gone, or the bot may not write there. Fluxer
 * names them in packages/constants ApiErrorCodes (UnknownWebhookError and
 * UnknownChannelError are 404s, MissingAccess and MissingPermissions 403s,
 * ThreadLockedError a 400); Discord uses numeric codes (10003 Unknown
 * Channel, 10004 Unknown Guild, 10015 Unknown Webhook, 50001 Missing
 * Access, 50013 Missing Permissions).
 */
const TARGET_CODES: ReadonlySet<string | number> = new Set([
    'UNKNOWN_WEBHOOK',
    'UNKNOWN_CHANNEL',
    'UNKNOWN_GUILD',
    'MISSING_ACCESS',
    'MISSING_PERMISSIONS',
    'UNAUTHORIZED',
    'THREAD_LOCKED',
    10003,
    10004,
    10015,
    50001,
    50013,
]);

/** HTTP statuses that blame the target when the body names no code. */
const TARGET_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** Fluxer refuses webhook edits in an archived or locked thread. */
const CLOSED_THREAD_CODES: ReadonlySet<string> = new Set([
    'THREAD_ARCHIVED',
    'THREAD_LOCKED',
]);

type Fields = Record<string, unknown>;

function fields(error: unknown): Fields {
    return typeof error === 'object' && error !== null ? (error as Fields) : {};
}

/** The HTTP status of a REST error, or null. */
export function statusOf(error: unknown): number | null {
    const { statusCode, status } = fields(error);
    if (typeof statusCode === 'number') return statusCode;
    return typeof status === 'number' ? status : null;
}

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The error itself, or what a MessageError wraps. */
function rootOf(error: unknown): unknown {
    return error instanceof MessageError ? error.cause : error;
}

function transientShape(error: unknown): boolean {
    const status = statusOf(error);
    if (status !== null) return status === 429 || status >= 500;
    const { code, name } = fields(error);
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    return TRANSIENT_TEXT.test(describeError(error));
}

/**
 * True for trouble that passes: rate limits, server errors, timeouts,
 * dropped connections and a gateway that is not connected yet. A fetch
 * failure's `cause` is checked too, one level deep.
 */
export function isTransient(error: unknown): boolean {
    const root = rootOf(error);
    if (transientShape(root)) return true;
    const { cause } = fields(root);
    return cause !== undefined && transientShape(cause);
}

/** A REST error's code: Fluxer's are strings, Discord's numbers. */
function codeOf(error: unknown): string | number | null {
    const { code } = fields(error);
    return typeof code === 'string' || typeof code === 'number' ? code : null;
}

/**
 * True when the error is about where copies go rather than about one
 * message: an unknown webhook, channel or guild, missing access, or a
 * refused login. Every message would fail the same way, so the job backs
 * off and fails instead of skipping messages one by one. A 401 always
 * counts; a 403 or 404 counts when its code is one of TARGET_CODES or
 * the body names no code. Another code, such as an unknown sticker, is
 * the message's own problem.
 */
export function isTargetError(error: unknown): boolean {
    const root = rootOf(error);
    const status = statusOf(root);
    if (status === 401) return true;
    const code = codeOf(root);
    if (code !== null) return TARGET_CODES.has(code);
    return status !== null && TARGET_STATUSES.has(status);
}

/** True when the webhook the copy was sent through no longer exists. */
export function isUnknownWebhook(error: unknown): boolean {
    const code = codeOf(rootOf(error));
    return code === 'UNKNOWN_WEBHOOK' || code === 10015;
}

/**
 * THREAD_ARCHIVED or THREAD_LOCKED when Fluxer refused a webhook edit
 * because its thread is closed, else null.
 */
export function closedThreadCode(error: unknown): string | null {
    const code = codeOf(rootOf(error));
    return typeof code === 'string' && CLOSED_THREAD_CODES.has(code)
        ? code
        : null;
}

/** True when the platform refused the message's files, not the message. */
export function isUploadError(error: unknown): boolean {
    const root = rootOf(error);
    if (statusOf(root) === 413) return true;
    const { code, errors } = fields(root);
    if (typeof code === 'string' && UPLOAD_CODES.has(code)) return true;
    if (errors === undefined || errors === null) return false;
    // Fluxer names the failing field in `errors`, such as attachments.0.
    return /"(attachments|files)\b/.test(JSON.stringify(errors));
}

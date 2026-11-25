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

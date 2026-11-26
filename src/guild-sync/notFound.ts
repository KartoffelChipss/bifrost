/**
 * Codes `@fluxerjs/core` throws, with no HTTP status, when it maps a 404
 * for a channel, thread, role or emoji (rethrowMapped, ErrorCodes in
 * @fluxerjs/util). A guild that is not found is not an object gone.
 */
const LIBRARY_NOT_FOUND = new Set([
    'CHANNEL_NOT_FOUND',
    'ROLE_NOT_FOUND',
    'EMOJI_NOT_FOUND',
]);

/** Fluxer and Discord both answer 404 for an object that is gone. */
export function isNotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const { status, statusCode, code } = error as {
        status?: unknown;
        statusCode?: unknown;
        code?: unknown;
    };
    if (status === 404 || statusCode === 404) return true;
    return typeof code === 'string' && LIBRARY_NOT_FOUND.has(code);
}

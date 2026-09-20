const BASE_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

let blockedUntil = 0;
let consecutiveBlocks = 0;

export function isFluxerApiBlockError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const { code, message } = err as { code?: unknown; message?: unknown };
    return (
        code === 'IP_BANNED' ||
        code === 'GLOBAL_IP_BANNED' ||
        (typeof message === 'string' &&
            message.includes('temporarily blocked from the Fluxer API'))
    );
}

export function isFluxerApiBlocked(): boolean {
    return Date.now() < blockedUntil;
}

/** Starts (or keeps) a cooldown. Returns the remaining cooldown in ms. */
export function markFluxerApiBlocked(): number {
    if (!isFluxerApiBlocked()) {
        const cooldown = Math.min(
            BASE_COOLDOWN_MS * 2 ** consecutiveBlocks,
            MAX_COOLDOWN_MS
        );
        consecutiveBlocks++;
        blockedUntil = Date.now() + cooldown;
    }
    return blockedUntil - Date.now();
}

export function markFluxerApiOk(): void {
    blockedUntil = 0;
    consecutiveBlocks = 0;
}

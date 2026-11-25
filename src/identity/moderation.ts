/**
 * Bans and timeouts that follow a linked member from Discord to Fluxer.
 * Only linked accounts are touched, only in apply, and a ban on Fluxer is
 * lifted only when this sync made it (its reason starts with BAN_REASON).
 */

/** The Fluxer ban reason, which marks a ban this sync may lift. */
export const BAN_REASON = 'Banned on Discord (Bifröst linked account)';
/** Bans per guild link per rolling hour; the rest wait for a later sweep. */
export const MAX_BANS_PER_HOUR = 10;
/** Timeout ends closer than this count as the same. */
const SAME_TIME_MS = 60_000;

export interface TimeoutChange {
    /** The new end as an ISO time; null lifts the timeout. */
    readonly until: string | null;
}

/** The time in ms, or null when absent, unreadable or already past. */
function activeUntil(value: string | null, now: number): number | null {
    if (value === null) return null;
    const at = Date.parse(value);
    return Number.isNaN(at) || at <= now ? null : at;
}

/**
 * The Fluxer timeout change for one member, or null for none. A Discord
 * timeout is copied. A Fluxer timeout is lifted only when it is the one
 * this process last wrote, never one a Fluxer moderator set.
 */
export function timeoutChange(
    discordUntil: string | null,
    fluxerUntil: string | null,
    lastWritten: string | undefined,
    now: number
): TimeoutChange | null {
    const discord = activeUntil(discordUntil, now);
    const fluxer = activeUntil(fluxerUntil, now);
    if (discord !== null) {
        const same =
            fluxer !== null && Math.abs(discord - fluxer) < SAME_TIME_MS;
        return same ? null : { until: new Date(discord).toISOString() };
    }
    if (fluxer === null || lastWritten === undefined) return null;
    const written = Date.parse(lastWritten);
    return Math.abs(written - fluxer) < SAME_TIME_MS ? { until: null } : null;
}

/** True when a Fluxer ban was made by this sync. */
export function ourBan(reason: string | null): boolean {
    return reason !== null && reason.startsWith(BAN_REASON);
}

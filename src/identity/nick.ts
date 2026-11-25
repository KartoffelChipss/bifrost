/**
 * Nickname sync for linked members (design: Role-membership sync). The
 * Discord server nickname is copied to the Fluxer member.
 *
 * Clearing: when a member removes their Discord nickname, the Fluxer
 * nickname is cleared only if it is the one this process last wrote. That
 * memory is in-process and lost on restart, so after a restart a stale
 * nickname stays until the member sets a new Discord one. This never clears
 * a nickname the member chose on Fluxer.
 */

/** Members whose last written nickname is kept at once. */
const MAX_REMEMBERED = 10_000;

export interface NickChange {
    /** The nickname to set; null clears it. */
    readonly nick: string | null;
}

/** The Fluxer nickname change for one member, or null for none. */
export function nickChange(
    discordNick: string | null,
    fluxerNick: string | null,
    lastWritten: string | undefined
): NickChange | null {
    if (discordNick !== null)
        return discordNick === fluxerNick ? null : { nick: discordNick };
    if (fluxerNick !== null && fluxerNick === lastWritten)
        return { nick: null };
    return null;
}

/** The nickname this process last wrote, per guild link and Fluxer member. */
export class NickMemory {
    private readonly written = new Map<string, string>();

    get(key: string): string | undefined {
        return this.written.get(key);
    }

    remember(key: string, nick: string | null): void {
        this.written.delete(key);
        if (nick === null) return;
        if (this.written.size >= MAX_REMEMBERED) {
            const oldest = this.written.keys().next();
            if (!oldest.done) this.written.delete(oldest.value);
        }
        this.written.set(key, nick);
    }
}

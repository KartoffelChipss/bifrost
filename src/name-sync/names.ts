import { webhookName } from '../relay-extras/fidelity/profile';

/** The names Discord holds for one member of one server. */
export interface DiscordNames {
    /** The server nickname, or null. */
    readonly nick: string | null;
    readonly globalName: string | null;
    readonly username: string;
}

/**
 * The name a Fluxer copy shows, exactly as the relay picks it: the server
 * nickname, else the global display name, else the username
 * (relay-extras/fidelity/sources.ts discordAuthor), falling back to the
 * username when Fluxer would refuse the name (fidelity/view.ts finishWith).
 */
export function copyName(names: DiscordNames): string {
    const display = names.nick ?? names.globalName ?? names.username;
    return webhookName(display, 'fluxer') ?? names.username;
}

/** Splits `items` into chunks of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
    if (!Number.isSafeInteger(size) || size < 1) {
        throw new RangeError('chunk size must be a positive integer');
    }
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

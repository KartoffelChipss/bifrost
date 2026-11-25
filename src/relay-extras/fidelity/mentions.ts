import type { TargetEmoji } from './types';

/** Source ID to target ID for each mention kind. */
export interface MentionMaps {
    readonly users: ReadonlyMap<string, string>;
    readonly roles: ReadonlyMap<string, string>;
    readonly channels: ReadonlyMap<string, string>;
}

/** Channel mentions looked up per message; the rest stay text. */
export const MAX_CHANNEL_LOOKUPS = 10;

const TOKEN = /^<(@!?|@&|#)(\d+)>$/;
const CHANNEL_TOKENS = /<#(\d+)>/g;
const EMOJI_TOKENS = /<(a?):([a-zA-Z0-9_]+):(\d+)>/g;
/** Mention tokens first, so their `@` is matched with them. */
const BREAKABLE = /<@[!&]?\d+>|@everyone|@here|@/g;
const ZERO_WIDTH_SPACE = '​';

/**
 * The target-side form of one mention token as sanitizeMentions matches
 * it (`<@id>`, `<@!id>`, `<@&id>`, `<#id>`), or null when it does not
 * map. Discord and Fluxer share this syntax (Fluxer's markdown parser,
 * packages/markdown_parser/rust/src/links.rs `parse_mention`).
 */
export function mapMentionToken(
    token: string,
    maps: MentionMaps
): string | null {
    const match = TOKEN.exec(token);
    if (!match) return null;
    const [, kind, id] = match;
    if (kind === '#') {
        const target = maps.channels.get(id);
        return target ? `<#${target}>` : null;
    }
    if (kind === '@&') {
        const target = maps.roles.get(id);
        return target ? `<@&${target}>` : null;
    }
    const target = maps.users.get(id);
    return target ? `<@${target}>` : null;
}

/** Distinct channel IDs mentioned in `content`, at most `limit`. */
export function channelIdsIn(content: string, limit: number): string[] {
    const ids = new Set<string>();
    for (const match of content.matchAll(CHANNEL_TOKENS)) {
        if (ids.size >= limit) break;
        ids.add(match[1]);
    }
    return [...ids];
}

/**
 * Replaces source custom emojis that guild-sync synced with the target
 * emoji. Upstream's replaceEmojis then runs as before: it matches the
 * rest by name, and leaves these alone because the target list holds them.
 */
export function mapEmojis(
    content: string,
    emojis: ReadonlyMap<string, string>,
    targetEmojis: readonly TargetEmoji[]
): string {
    if (emojis.size === 0) return content;
    return content.replace(EMOJI_TOKENS, (token, animated, name, id) => {
        const targetId = emojis.get(id);
        if (!targetId) return token;
        const known = targetEmojis.find((emoji) => emoji.id === targetId);
        const a = (known ? known.animated : animated === 'a') ? 'a' : '';
        return `<${a}:${known?.name ?? name}:${targetId}>`;
    });
}

/**
 * Upstream's breakMentions puts a zero-width space after every `@`. This
 * does the same, except for mention tokens, which sanitizeMentions left
 * only where they map, and for `@everyone` and `@here` when the copy may
 * ping everyone.
 */
export function breakUnpinged(content: string, everyone: boolean): string {
    return content.replace(BREAKABLE, (match) => {
        if (match.startsWith('<')) return match;
        if (match !== '@' && everyone) return match;
        return `@${ZERO_WIDTH_SPACE}${match.slice(1)}`;
    });
}

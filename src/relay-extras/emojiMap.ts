import type { MapRow } from '../guild-sync/ops';
import { otherSide, type ReactionEmoji, type Side } from './types';

/** guild-sync rewrites emoji pairs rarely; a few minutes stale is fine. */
export const EMOJI_MAP_TTL_MS = 5 * 60_000;
/** Upper bound on guild links whose emoji pairs are cached. */
export const MAX_CACHED_LINKS = 100;

export interface EmojiMapDeps {
    /** guild-sync's addon_object_map rows for one guild link. */
    loadObjectMap(guildLinkId: string): Promise<readonly MapRow[]>;
    /** A custom emoji of the guild link's server on `side`, if it is there. */
    guildEmoji(
        side: Side,
        guildLinkId: string,
        emojiId: string
    ): Promise<ReactionEmoji | null>;
    now(): number;
}

interface CachedPairs {
    readonly at: number;
    readonly toFluxer: ReadonlyMap<string, string>;
    readonly toDiscord: ReadonlyMap<string, string>;
}

function emojiPairs(rows: readonly MapRow[], at: number): CachedPairs {
    const toFluxer = new Map<string, string>();
    const toDiscord = new Map<string, string>();
    for (const row of rows) {
        if (row.kind !== 'emoji' || row.state !== 'active') continue;
        if (!row.discordId || !row.fluxerId) continue;
        toFluxer.set(row.discordId, row.fluxerId);
        toDiscord.set(row.fluxerId, row.discordId);
    }
    return { at, toFluxer, toDiscord };
}

/**
 * Translates a reaction emoji to the other platform. A unicode emoji passes
 * through. A custom emoji needs a pair in guild-sync's object map and must
 * still exist on the other server; otherwise it cannot be mirrored.
 */
export class EmojiTranslator {
    private readonly cache = new Map<string, CachedPairs>();

    constructor(private readonly deps: EmojiMapDeps) {}

    private async pairs(guildLinkId: string): Promise<CachedPairs> {
        const now = this.deps.now();
        const cached = this.cache.get(guildLinkId);
        if (cached && now - cached.at < EMOJI_MAP_TTL_MS) return cached;
        const rows = await this.deps.loadObjectMap(guildLinkId);
        const fresh = emojiPairs(rows, now);
        this.cache.delete(guildLinkId);
        if (this.cache.size >= MAX_CACHED_LINKS) {
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
        }
        this.cache.set(guildLinkId, fresh);
        return fresh;
    }

    async translate(
        from: Side,
        guildLinkId: string,
        emoji: ReactionEmoji
    ): Promise<ReactionEmoji | null> {
        if (emoji.id === null) return emoji.name ? emoji : null;
        const pairs = await this.pairs(guildLinkId);
        const map = from === 'discord' ? pairs.toFluxer : pairs.toDiscord;
        const destId = map.get(emoji.id);
        if (!destId) return null;
        return this.deps.guildEmoji(otherSide(from), guildLinkId, destId);
    }
}

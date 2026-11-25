import type { SourceSticker } from './types';

/** Fluxer takes at most 3 sticker IDs (WebhookRequestSchemas.ts). */
export const MAX_STICKERS = 3;

/** The synced stickers a copy sends natively, and the images they replace. */
export interface StickerSwap {
    /** Target sticker IDs, at most MAX_STICKERS. */
    readonly ids: readonly string[];
    /** Upstream's attachment URLs of the stickers sent natively. */
    readonly replacedUrls: ReadonlySet<string>;
}

export const NO_STICKERS: StickerSwap = { ids: [], replacedUrls: new Set() };

/**
 * Picks the source stickers guild-sync synced and that the target server
 * still has. Fluxer fails a webhook send with an unknown sticker
 * (MessageStickerService.ts, CUSTOM_STICKER_NOT_FOUND), so a sticker
 * missing from the target list keeps upstream's image attachment.
 */
export function swapStickers(
    stickers: readonly SourceSticker[],
    synced: ReadonlyMap<string, string>,
    onTarget: ReadonlySet<string>
): StickerSwap {
    const ids: string[] = [];
    const replacedUrls = new Set<string>();
    for (const sticker of stickers.slice(0, MAX_STICKERS)) {
        const targetId = synced.get(sticker.id);
        if (!targetId || !onTarget.has(targetId)) continue;
        if (ids.includes(targetId)) continue;
        ids.push(targetId);
        replacedUrls.add(sticker.url);
    }
    return { ids, replacedUrls };
}

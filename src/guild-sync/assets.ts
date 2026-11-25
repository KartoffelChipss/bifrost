import { StickerFormatType, type Client } from 'discord.js';
import { withTimeout } from '../addons/host';

/**
 * Emoji and sticker images, read from the source so they can be uploaded
 * to the destination. An image is returned as a base64 data URI.
 */
export interface AssetSource {
    image(
        guildId: string,
        kind: 'emoji' | 'sticker',
        id: string
    ): Promise<string>;
}

/** Fluxer refuses a larger emoji or sticker (AssetFormatPolicy.ts). */
export const MAX_ASSET_BYTES = 512 * 1024;
export const ASSET_TIMEOUT_MS = 15_000;

const DISCORD_ASSET_HOSTS: ReadonlySet<string> = new Set([
    'cdn.discordapp.com',
    'media.discordapp.net',
]);

type Fetch = (
    url: string,
    init: { signal: AbortSignal }
) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * Downloads one image from Discord's CDN. The host, the content type and
 * the size are checked, because the bytes go straight to another service.
 */
export async function downloadImage(
    url: string,
    fetchFn: Fetch = fetch,
    maxBytes = MAX_ASSET_BYTES
): Promise<string> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !DISCORD_ASSET_HOSTS.has(parsed.host)) {
        throw new Error(`refusing to download from ${parsed.host}`);
    }
    const response = await fetchFn(url, {
        signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`image download: HTTP ${response.status}`);
    const type = (response.headers.get('content-type') ?? '').split(';')[0];
    if (!type.startsWith('image/')) {
        throw new Error(`image download: unexpected type "${type}"`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) {
        throw new Error(`image is ${bytes.length} bytes, limit ${maxBytes}`);
    }
    return `data:${type};base64,${bytes.toString('base64')}`;
}

/** Reads emoji and sticker images of a Discord server. */
export class DiscordAssetSource implements AssetSource {
    constructor(private readonly client: Client) {}

    private async url(
        guildId: string,
        kind: 'emoji' | 'sticker',
        id: string
    ): Promise<string> {
        const guild = await this.client.guilds.fetch(guildId);
        if (kind === 'emoji') {
            const emoji = await guild.emojis.fetch(id);
            return emoji.imageURL({
                extension: emoji.animated ? 'gif' : 'png',
            });
        }
        const sticker = await guild.stickers.fetch(id);
        if (sticker.format === StickerFormatType.Lottie) {
            throw new Error('Lottie stickers cannot be copied');
        }
        return sticker.url;
    }

    async image(
        guildId: string,
        kind: 'emoji' | 'sticker',
        id: string
    ): Promise<string> {
        const url = await withTimeout(
            this.url(guildId, kind, id),
            ASSET_TIMEOUT_MS,
            `Discord ${kind} lookup`
        );
        return downloadImage(url);
    }
}

import type { MapRow } from '../../guild-sync/ops';
import type { AccountPair, Side } from './types';

/** Source ID to target ID, for one direction of one guild link. */
export interface ObjectIds {
    readonly roles: ReadonlyMap<string, string>;
    readonly channels: ReadonlyMap<string, string>;
    readonly emojis: ReadonlyMap<string, string>;
    readonly stickers: ReadonlyMap<string, string>;
}

/** Both directions of one map, keyed by the source side. */
export interface Directed<T> {
    readonly discord: T;
    readonly fluxer: T;
}

type Bucket = keyof ObjectIds;

/** Channels, categories and threads share one mention syntax. */
const BUCKETS: Partial<Record<MapRow['kind'], Bucket>> = {
    role: 'roles',
    channel: 'channels',
    category: 'channels',
    thread: 'channels',
    emoji: 'emojis',
    sticker: 'stickers',
};

function emptyIds(): Record<Bucket, Map<string, string>> {
    return {
        roles: new Map(),
        channels: new Map(),
        emojis: new Map(),
        stickers: new Map(),
    };
}

/** Active pairs of guild-sync's object map, in both directions. */
export function objectIds(rows: readonly MapRow[]): Directed<ObjectIds> {
    const discord = emptyIds();
    const fluxer = emptyIds();
    for (const row of rows) {
        const bucket = BUCKETS[row.kind];
        if (!bucket || row.state !== 'active') continue;
        if (!row.discordId || !row.fluxerId) continue;
        discord[bucket].set(row.discordId, row.fluxerId);
        fluxer[bucket].set(row.fluxerId, row.discordId);
    }
    return { discord, fluxer };
}

/** Linked accounts as user ID maps, in both directions. */
export function accountIds(
    pairs: readonly AccountPair[]
): Directed<ReadonlyMap<string, string>> {
    const discord = new Map<string, string>();
    const fluxer = new Map<string, string>();
    for (const pair of pairs) {
        discord.set(pair.discordUserId, pair.fluxerUserId);
        fluxer.set(pair.fluxerUserId, pair.discordUserId);
    }
    return { discord, fluxer };
}

/** The channel ID on the other side of a channel link. */
export function linkedChannel(
    link: { discordChannelId: string; fluxerChannelId: string },
    from: Side
): string {
    return from === 'discord' ? link.fluxerChannelId : link.discordChannelId;
}

import type { MapRow } from '../../src/guild-sync/ops';
import type {
    ChannelSnap,
    GuildSnapshot,
    RoleSnap,
} from '../../src/guild-sync/snapshot';

export const D_GUILD = '100';
export const F_GUILD = '900';

export function role(id: string, overrides: Partial<RoleSnap> = {}): RoleSnap {
    return {
        id,
        name: `role-${id}`,
        color: 0,
        hoist: false,
        mentionable: false,
        permissions: '0',
        position: 1,
        managed: false,
        ...overrides,
    };
}

export function channel(
    id: string,
    overrides: Partial<ChannelSnap> = {}
): ChannelSnap {
    return {
        id,
        type: 0,
        name: `channel-${id}`,
        position: 0,
        parentId: null,
        topic: null,
        nsfw: false,
        rateLimitPerUser: 0,
        bitrate: null,
        userLimit: null,
        overwrites: [],
        tags: [],
        ...overrides,
    };
}

export function discordGuild(
    overrides: Partial<GuildSnapshot> = {}
): GuildSnapshot {
    return {
        side: 'discord',
        guildId: D_GUILD,
        name: 'Server',
        icon: null,
        banner: null,
        everyoneRoleId: D_GUILD,
        roles: [role(D_GUILD, { name: '@everyone', position: 0 })],
        channels: [channel('101')],
        emojis: [],
        stickers: [],
        threads: [],
        threadGaps: [],
        bot: null,
        ...overrides,
    };
}

export function fluxerGuild(
    overrides: Partial<GuildSnapshot> = {}
): GuildSnapshot {
    return {
        side: 'fluxer',
        guildId: F_GUILD,
        name: 'Server',
        icon: null,
        banner: null,
        everyoneRoleId: F_GUILD,
        roles: [role(F_GUILD, { name: '@everyone', position: 0 })],
        channels: [],
        emojis: [],
        stickers: [],
        threads: [],
        threadGaps: [],
        bot: { userId: 'bot', roleIds: [], isOwner: true },
        ...overrides,
    };
}

let rowSeq = 0;

export function mapRow(
    kind: MapRow['kind'],
    discordId: string,
    fluxerId: string,
    overrides: Partial<MapRow> = {}
): MapRow {
    rowSeq += 1;
    return {
        id: `row-${rowSeq}`,
        kind,
        discordId,
        fluxerId,
        state: 'active',
        createdBySync: true,
        missingSince: null,
        missingCount: 0,
        appliedFields: null,
        ...overrides,
    };
}

/** Deterministic PRNG (mulberry32) for property tests. */
export function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

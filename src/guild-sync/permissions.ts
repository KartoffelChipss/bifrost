import type { SyncDirection } from '../addons/db/schema';

/**
 * Permission translation by flag name (design: Permission translation).
 *
 * Each row pairs a discord.js flag name with its @fluxerjs/util name and the
 * bit both libraries use. test/guild-sync/permissions.test.ts checks every
 * row against both libraries, so an upgrade that moves a bit fails the
 * build. Bits missing from this table are never written: Discord-only bits
 * are dropped and reported, Fluxer-only bits are left as they are.
 */
export const PERMISSION_TABLE = [
    ['CreateInstantInvite', 'CreateInstantInvite', 0],
    ['KickMembers', 'KickMembers', 1],
    ['BanMembers', 'BanMembers', 2],
    ['Administrator', 'Administrator', 3],
    ['ManageChannels', 'ManageChannels', 4],
    ['ManageGuild', 'ManageGuild', 5],
    ['AddReactions', 'AddReactions', 6],
    ['ViewAuditLog', 'ViewAuditLog', 7],
    ['PrioritySpeaker', 'PrioritySpeaker', 8],
    ['Stream', 'Stream', 9],
    ['ViewChannel', 'ViewChannel', 10],
    ['SendMessages', 'SendMessages', 11],
    ['SendTTSMessages', 'SendTtsMessages', 12],
    ['ManageMessages', 'ManageMessages', 13],
    ['EmbedLinks', 'EmbedLinks', 14],
    ['AttachFiles', 'AttachFiles', 15],
    ['ReadMessageHistory', 'ReadMessageHistory', 16],
    ['MentionEveryone', 'MentionEveryone', 17],
    ['UseExternalEmojis', 'UseExternalEmojis', 18],
    ['Connect', 'Connect', 20],
    ['Speak', 'Speak', 21],
    ['MuteMembers', 'MuteMembers', 22],
    ['DeafenMembers', 'DeafenMembers', 23],
    ['MoveMembers', 'MoveMembers', 24],
    ['UseVAD', 'UseVad', 25],
    ['ChangeNickname', 'ChangeNickname', 26],
    ['ManageNicknames', 'ManageNicknames', 27],
    ['ManageRoles', 'ManageRoles', 28],
    ['ManageWebhooks', 'ManageWebhooks', 29],
    ['ManageGuildExpressions', 'ManageExpressions', 30],
    ['UseExternalStickers', 'UseExternalStickers', 37],
    ['ModerateMembers', 'ModerateMembers', 40],
    ['CreateGuildExpressions', 'CreateExpressions', 43],
    ['PinMessages', 'PinMessages', 51],
    ['BypassSlowmode', 'BypassSlowmode', 52],
] as const;

/** Bits only one platform has, named for reports. Never written. */
export const DISCORD_ONLY_BITS = {
    ViewGuildInsights: 19,
    UseApplicationCommands: 31,
    RequestToSpeak: 32,
    ManageEvents: 33,
    UseEmbeddedActivities: 39,
    ViewCreatorMonetizationAnalytics: 41,
    UseSoundboard: 42,
    CreateEvents: 44,
    UseExternalSounds: 45,
    SendVoiceMessages: 46,
    SendPolls: 49,
    UseExternalApps: 50,
} as const;

/**
 * Thread permissions. The Fluxer server defines them on the same bits as
 * Discord (ThreadPermissionUtils.ts), but @fluxerjs/util 3.1.0 does not
 * list them yet, so they cannot sit in PERMISSION_TABLE. Members need
 * SendMessagesInThreads to reply inside a forum post.
 */
export const THREAD_BITS = {
    ManageThreads: 34,
    CreatePublicThreads: 35,
    CreatePrivateThreads: 36,
    SendMessagesInThreads: 38,
} as const;

export const FLUXER_ONLY_BITS = {
    UpdateRtcRegion: 53,
    ViewChannelMembers: 54,
} as const;

// The build targets ES6, which has no bigint literals.
export const NO_BITS = BigInt(0);

/** The bitfield with only `bit` set. */
export function bitOf(bit: number): bigint {
    return BigInt(1) << BigInt(bit);
}

export const ADMINISTRATOR = bitOf(3);

/** Every bit guild-sync manages. Other destination bits are preserved. */
export const MANAGED_BITS: bigint = [
    ...PERMISSION_TABLE.map(([, , bit]) => bit),
    ...Object.values(THREAD_BITS),
].reduce((mask, bit) => mask | bitOf(bit), NO_BITS);

/** Highest bit either library defines today, as a bound for scans. */
const MAX_BIT = 63;

export interface TranslatedPermissions {
    /** Managed bits only, ready to merge into the destination value. */
    readonly bits: bigint;
    /** Source flag names with no counterpart on the destination. */
    readonly dropped: readonly string[];
}

function nameForBit(bit: number, direction: SyncDirection): string {
    const row = PERMISSION_TABLE.find(([, , b]) => b === bit);
    if (row) return direction === 'discord-to-fluxer' ? row[0] : row[1];
    const thread = Object.entries(THREAD_BITS).find(([, b]) => b === bit);
    if (thread) return thread[0];
    const only =
        direction === 'discord-to-fluxer'
            ? DISCORD_ONLY_BITS
            : FLUXER_ONLY_BITS;
    const named = Object.entries(only).find(([, b]) => b === bit);
    return named ? named[0] : `bit${bit}`;
}

/**
 * Keeps the managed bits of a source bitfield. Bit positions match for
 * every managed flag, so translation is a mask plus a report of the rest.
 */
export function translatePermissions(
    source: bigint,
    direction: SyncDirection
): TranslatedPermissions {
    if (source < NO_BITS)
        throw new RangeError('Permission bitfield is negative');
    const dropped: string[] = [];
    for (let bit = 0; bit <= MAX_BIT; bit++) {
        const flag = bitOf(bit);
        if ((source & flag) !== NO_BITS && (MANAGED_BITS & flag) === NO_BITS) {
            dropped.push(nameForBit(bit, direction));
        }
    }
    return { bits: source & MANAGED_BITS, dropped };
}

/**
 * The destination value after an update: managed bits from the source,
 * unmanaged bits kept from the destination ("preserve, don't strip").
 */
export function mergePermissions(destination: bigint, managed: bigint): bigint {
    if (destination < NO_BITS || managed < NO_BITS) {
        throw new RangeError('Permission bitfield is negative');
    }
    return (destination & ~MANAGED_BITS) | (managed & MANAGED_BITS);
}

/** Flag names set in `bits`, for reports. */
export function flagNames(bits: bigint, direction: SyncDirection): string[] {
    const names: string[] = [];
    for (let bit = 0; bit <= MAX_BIT; bit++) {
        if ((bits & bitOf(bit)) !== NO_BITS) {
            names.push(nameForBit(bit, direction));
        }
    }
    return names;
}

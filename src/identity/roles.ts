import type { MapRow } from '../guild-sync/ops';
import { bitOf, NO_BITS } from '../guild-sync/permissions';
import type { GuildSnapshot } from '../guild-sync/snapshot';

/**
 * Which roles follow a linked member (design: Role-membership sync). Only
 * roles guild-sync maps are touched, and never a privileged one, so linking
 * an account can never hand out moderator rights.
 */

/**
 * Bits that give moderator or admin rights. A role with any of them, on the
 * server or in a channel overwrite, never follows a member.
 */
export const PRIVILEGED_BIT_NUMBERS = [
    1, // KickMembers
    2, // BanMembers
    3, // Administrator
    4, // ManageChannels
    5, // ManageGuild
    7, // ViewAuditLog
    13, // ManageMessages
    17, // MentionEveryone
    22, // MuteMembers
    23, // DeafenMembers
    24, // MoveMembers
    27, // ManageNicknames
    28, // ManageRoles
    29, // ManageWebhooks
    30, // ManageGuildExpressions
    33, // ManageEvents
    34, // ManageThreads
    40, // ModerateMembers
    43, // CreateGuildExpressions
    44, // CreateEvents
    51, // PinMessages
    52, // BypassSlowmode
] as const;

export const PRIVILEGED_BITS = PRIVILEGED_BIT_NUMBERS.reduce(
    (bits, bit) => bits | bitOf(bit),
    NO_BITS
);

const isPrivileged = (permissions: string) =>
    (BigInt(permissions) & PRIVILEGED_BITS) !== NO_BITS;

/** Roles that a channel overwrite grants a privileged bit to. */
function rolesWithPrivilegedOverwrites(source: GuildSnapshot): Set<string> {
    const roles = new Set<string>();
    for (const channel of source.channels) {
        for (const overwrite of channel.overwrites) {
            if (overwrite.type === 0 && isPrivileged(overwrite.allow))
                roles.add(overwrite.id);
        }
    }
    return roles;
}

/** Discord role ID to Fluxer role ID for active role rows. */
function mappedRoles(rows: readonly MapRow[]): Map<string, string> {
    const mapped = new Map<string, string>();
    for (const row of rows) {
        if (row.kind !== 'role' || row.state !== 'active') continue;
        if (row.discordId && row.fluxerId)
            mapped.set(row.discordId, row.fluxerId);
    }
    return mapped;
}

/**
 * Discord role ID to Fluxer role ID for every role the sync manages on a
 * member: mapped roles that are neither the everyone role nor managed by
 * an integration. A privileged one is removed when the member loses it on
 * Discord, but never added (see syncableRoles).
 */
export function managedRoles(
    source: GuildSnapshot,
    rows: readonly MapRow[]
): Map<string, string> {
    const mapped = mappedRoles(rows);
    const roles = new Map<string, string>();
    for (const role of source.roles) {
        const dest = mapped.get(role.id);
        if (!dest || role.managed || role.id === source.everyoneRoleId)
            continue;
        roles.set(role.id, dest);
    }
    return roles;
}

/** Discord role ID to Fluxer role ID, for every role that may be added. */
export function syncableRoles(
    source: GuildSnapshot,
    rows: readonly MapRow[]
): Map<string, string> {
    const overwritten = rolesWithPrivilegedOverwrites(source);
    const roles = new Map<string, string>();
    for (const [id, dest] of managedRoles(source, rows)) {
        const role = source.roles.find((r) => r.id === id);
        if (!role || isPrivileged(role.permissions) || overwritten.has(id))
            continue;
        roles.set(id, dest);
    }
    return roles;
}

export interface RoleChange {
    readonly add: readonly string[];
    readonly remove: readonly string[];
}

/**
 * The Fluxer roles to add and remove for one member. Only `syncable`
 * roles are added. Any `managed` role the member does not hold on Discord
 * is removed, including one that became privileged after it was given.
 * A Fluxer role the sync does not manage is never removed.
 */
export function roleChanges(
    discordRoleIds: readonly string[],
    fluxerRoleIds: readonly string[],
    syncable: ReadonlyMap<string, string>,
    managed: ReadonlyMap<string, string> = syncable
): RoleChange {
    const held = new Set<string>();
    const wanted = new Set<string>();
    for (const id of discordRoleIds) {
        const kept = managed.get(id) ?? syncable.get(id);
        if (kept) held.add(kept);
        const dest = syncable.get(id);
        if (dest) wanted.add(dest);
    }
    const all = new Set([...managed.values(), ...syncable.values()]);
    const have = new Set(fluxerRoleIds);
    return {
        add: [...wanted].filter((id) => !have.has(id)).sort(),
        remove: fluxerRoleIds
            .filter((id) => all.has(id) && !held.has(id))
            .sort(),
    };
}

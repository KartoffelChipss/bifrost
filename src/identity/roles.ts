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

/** Discord role ID to Fluxer role ID, for every role that may follow a member. */
export function syncableRoles(
    source: GuildSnapshot,
    rows: readonly MapRow[]
): Map<string, string> {
    const mapped = new Map<string, string>();
    for (const row of rows) {
        if (row.kind !== 'role' || row.state !== 'active') continue;
        if (row.discordId && row.fluxerId)
            mapped.set(row.discordId, row.fluxerId);
    }
    const overwritten = rolesWithPrivilegedOverwrites(source);
    const roles = new Map<string, string>();
    for (const role of source.roles) {
        const dest = mapped.get(role.id);
        if (!dest || role.managed || role.id === source.everyoneRoleId)
            continue;
        if (isPrivileged(role.permissions) || overwritten.has(role.id))
            continue;
        roles.set(role.id, dest);
    }
    return roles;
}

export interface RoleChange {
    readonly add: readonly string[];
    readonly remove: readonly string[];
}

/**
 * The Fluxer roles to add and remove for one member. A Fluxer role the sync
 * does not manage is never removed.
 */
export function roleChanges(
    discordRoleIds: readonly string[],
    fluxerRoleIds: readonly string[],
    syncable: ReadonlyMap<string, string>
): RoleChange {
    const wanted = new Set<string>();
    for (const id of discordRoleIds) {
        const dest = syncable.get(id);
        if (dest) wanted.add(dest);
    }
    const managed = new Set(syncable.values());
    const have = new Set(fluxerRoleIds);
    return {
        add: [...wanted].filter((id) => !have.has(id)).sort(),
        remove: fluxerRoleIds
            .filter((id) => managed.has(id) && !wanted.has(id))
            .sort(),
    };
}

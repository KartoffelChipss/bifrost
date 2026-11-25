import type { MapRow } from '../guild-sync/ops';
import { bitOf, NO_BITS } from '../guild-sync/permissions';
import type { GuildSnapshot } from '../guild-sync/snapshot';

/**
 * Which roles follow a linked member (design: Role-membership sync). Only
 * roles guild-sync maps are touched, and never a privileged one, so linking
 * an account can never hand out moderator rights.
 */

/** Administrator, Manage Server, Manage Roles, Manage Channels, Ban, Kick, Moderate. */
export const PRIVILEGED_BITS = [3, 5, 28, 4, 2, 1, 40].reduce(
    (bits, bit) => bits | bitOf(bit),
    NO_BITS
);

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
    const roles = new Map<string, string>();
    for (const role of source.roles) {
        const dest = mapped.get(role.id);
        if (!dest || role.managed || role.id === source.everyoneRoleId)
            continue;
        if ((BigInt(role.permissions) & PRIVILEGED_BITS) !== NO_BITS) continue;
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

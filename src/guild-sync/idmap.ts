import type { SyncDirection } from '../addons/db/schema';
import type { JsonValue, MapRow, SyncKind } from './ops';
import { destIdOf, sourceIdOf } from './ops';
import type { GuildSnapshot } from './snapshot';

const IMPLICIT_KINDS: ReadonlySet<SyncKind> = new Set(['role', 'guild']);

/**
 * Source-to-destination ID pairs from `addon_object_map`, per kind.
 *
 * The @everyone pair is implicit: its ID is the guild ID on both sides. So
 * is the guild pair, which the upstream guild link already records. Both
 * may be updated but are never owned, so ownership never lets them be
 * archived or deleted.
 */
export class IdMap {
    private readonly pairs = new Map<SyncKind, Map<string, string>>();
    private readonly owned = new Map<SyncKind, Set<string>>();
    private readonly appliedBySource = new Map<
        string,
        Readonly<Record<string, JsonValue>> | null
    >();
    private readonly appliedByDest = new Map<
        string,
        Readonly<Record<string, JsonValue>> | null
    >();

    constructor(
        rows: readonly MapRow[],
        direction: SyncDirection,
        readonly sourceEveryone: string,
        readonly destEveryone: string
    ) {
        for (const row of rows) {
            if (row.kind === 'overwrite' || row.state === 'tombstoned')
                continue;
            const sourceId = sourceIdOf(row, direction);
            const destId = destIdOf(row, direction);
            if (!sourceId || !destId) continue;
            this.pairsFor(row.kind).set(sourceId, destId);
            this.ownedFor(row.kind).add(destId);
            this.appliedBySource.set(
                `${row.kind}:${sourceId}`,
                row.appliedFields
            );
            this.appliedByDest.set(`${row.kind}:${destId}`, row.appliedFields);
        }
    }

    static from(
        rows: readonly MapRow[],
        direction: SyncDirection,
        source: GuildSnapshot,
        destination: GuildSnapshot
    ): IdMap {
        return new IdMap(
            rows,
            direction,
            source.everyoneRoleId,
            destination.everyoneRoleId
        );
    }

    /** The destination ID for a source object, or null when unmapped. */
    dest(kind: SyncKind, sourceId: string): string | null {
        if (IMPLICIT_KINDS.has(kind) && sourceId === this.sourceEveryone) {
            return this.destEveryone;
        }
        if (kind === 'guild') return null;
        return this.pairs.get(kind)?.get(sourceId) ?? null;
    }

    /** True when the source object has an `addon_object_map` row. */
    hasRow(kind: SyncKind, sourceId: string): boolean {
        return this.appliedBySource.has(`${kind}:${sourceId}`);
    }

    /** The fields last written for a source object, or null if none. */
    applied(
        kind: SyncKind,
        sourceId: string
    ): Readonly<Record<string, JsonValue>> | null {
        return this.appliedBySource.get(`${kind}:${sourceId}`) ?? null;
    }

    /** The fields last written to a destination object, or null. */
    appliedTo(
        kind: SyncKind,
        destId: string
    ): Readonly<Record<string, JsonValue>> | null {
        return this.appliedByDest.get(`${kind}:${destId}`) ?? null;
    }

    /** True when the destination object has an `addon_object_map` row. */
    owns(kind: SyncKind, destId: string): boolean {
        if (destId === this.destEveryone) return false;
        return this.owned.get(kind)?.has(destId) ?? false;
    }

    /** True when updates may touch the destination object. */
    mayUpdate(kind: SyncKind, destId: string): boolean {
        if (IMPLICIT_KINDS.has(kind) && destId === this.destEveryone) {
            return true;
        }
        return this.owns(kind, destId);
    }

    /** True for a role ID the diff manages on the destination. */
    managesDestRole(destId: string): boolean {
        return this.mayUpdate('role', destId);
    }

    private pairsFor(kind: SyncKind): Map<string, string> {
        let map = this.pairs.get(kind);
        if (!map) {
            map = new Map();
            this.pairs.set(kind, map);
        }
        return map;
    }

    private ownedFor(kind: SyncKind): Set<string> {
        let set = this.owned.get(kind);
        if (!set) {
            set = new Set();
            this.owned.set(kind, set);
        }
        return set;
    }
}

import type {
    ObjectKind,
    ObjectState,
    SyncDirection,
} from '../addons/db/schema';

/** Object kinds a plan can act on. Overwrites ride on channel updates. */
export type SyncKind = Exclude<ObjectKind, 'overwrite'>;

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

export interface FieldChange {
    readonly field: string;
    readonly from: JsonValue;
    readonly to: JsonValue;
}

export type PlanOp =
    | {
          readonly op: 'create';
          readonly kind: SyncKind;
          readonly sourceId: string;
          readonly name: string;
          /** An unmapped destination object with the same name and type. */
          readonly existingDestId: string | null;
          /**
           * The existing object is this create's own earlier result (see
           * adopt.ts): it is recorded as created by sync, not created again.
           */
          readonly adopt?: true;
      }
    | {
          readonly op: 'update';
          readonly kind: SyncKind;
          readonly sourceId: string;
          readonly destId: string;
          readonly changes: readonly FieldChange[];
          /**
           * The fields that match the source once this update is written:
           * the changes plus fields that were already equal at plan time.
           * Drifted fields are left out, so their base stays as it was.
           * Plans saved before this field fall back to the changes alone.
           */
          readonly settled?: { readonly [field: string]: JsonValue };
          /**
           * First sync of @everyone or the server itself: the destination
           * was never written, so every difference follows the source.
           */
          readonly baseline?: true;
      }
    | {
          readonly op: 'reorder';
          readonly kind: 'role' | 'channel';
          /** 'roles', 'top' or the destination category ID. */
          readonly scope: string;
          readonly destIds: readonly string[];
      }
    | {
          /** Bridges a channel pair, so the relay copies its messages. */
          readonly op: 'link';
          readonly kind: 'channel';
          readonly sourceId: string;
          readonly destId: string;
      }
    | {
          readonly op: 'archive';
          readonly kind: SyncKind;
          readonly sourceId: string;
          readonly destId: string;
      }
    | {
          readonly op: 'hard-delete';
          readonly kind: SyncKind;
          readonly sourceId: string;
          readonly destId: string;
          /** Adopted at bootstrap, not created by sync. Needs approval. */
          readonly adopted: boolean;
      };

export type FindingType =
    | 'drift'
    | 'skipped'
    | 'missing-on-destination'
    | 'category-full'
    | 'permission-dropped'
    | 'not-held-by-bot'
    | 'dropped-by-ownership'
    | 'removal-deferred';

/** Something the plan reports but does not act on. */
export interface Finding {
    readonly type: FindingType;
    readonly kind: SyncKind;
    readonly id: string;
    readonly detail: string;
}

/** One `addon_object_map` row, as the diff and guards read it. */
export interface MapRow {
    readonly id: string;
    readonly kind: ObjectKind;
    readonly discordId: string | null;
    readonly fluxerId: string | null;
    readonly state: ObjectState;
    readonly createdBySync: boolean;
    readonly missingSince: Date | null;
    readonly missingCount: number;
    /** Field values of the last successful write, or null if never written. */
    readonly appliedFields: Readonly<Record<string, JsonValue>> | null;
}

export function sourceIdOf(row: MapRow, direction: SyncDirection) {
    return direction === 'discord-to-fluxer' ? row.discordId : row.fluxerId;
}

export function destIdOf(row: MapRow, direction: SyncDirection) {
    return direction === 'discord-to-fluxer' ? row.fluxerId : row.discordId;
}

export function isRemoval(op: PlanOp): boolean {
    return op.op === 'archive' || op.op === 'hard-delete';
}

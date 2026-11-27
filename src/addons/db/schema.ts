/**
 * Table names and allowed column values for the add-on tables.
 *
 * Every table carries the `addon_` prefix so it can never collide with a
 * table upstream Bifröst adds later. The value lists here are also enforced
 * by CHECK constraints in the migrations.
 */

export const TABLES = {
    objectMap: 'addon_object_map',
    snapshots: 'addon_snapshots',
    plans: 'addon_plans',
    auditLog: 'addon_audit_log',
    settings: 'addon_settings',
    leaderLock: 'addon_leader_lock',
    threadMessages: 'addon_thread_messages',
    historyJobs: 'addon_history_jobs',
    historyMessages: 'addon_history_messages',
    historyOptOuts: 'addon_history_optouts',
    historyMentions: 'addon_history_mentions',
    mentionFixups: 'addon_history_mention_fixups',
    identityLinks: 'addon_identity_links',
    identityCodes: 'addon_identity_codes',
    identityPending: 'addon_identity_pending',
    identityFailures: 'addon_identity_failures',
    parkedMessages: 'addon_parked_messages',
    failureCounts: 'addon_failure_counts',
    archiveChannels: 'addon_archive_channels',
    archiveMessages: 'addon_archive_messages',
    archiveMembers: 'addon_archive_members',
    archiveFiles: 'addon_archive_files',
    nameSync: 'addon_name_sync',
} as const;

/** Umzug's record of applied add-on migrations, apart from upstream's. */
export const MIGRATIONS_TABLE = 'addon_migrations';
export const MIGRATIONS_MODEL = 'AddonMigrationMeta';

export const OBJECT_KINDS = [
    'guild',
    'role',
    'category',
    'channel',
    'overwrite',
    'emoji',
    'sticker',
    'thread',
] as const;

export const OBJECT_STATES = ['active', 'archived', 'tombstoned'] as const;

export const SNAPSHOT_SIDES = ['discord', 'fluxer'] as const;

export const SYNC_DIRECTIONS = [
    'discord-to-fluxer',
    'fluxer-to-discord',
] as const;

export const PLAN_STATUSES = [
    'dry-run',
    'pending-approval',
    'applied',
    'aborted',
] as const;

export const SYNC_MODES = ['read-only', 'dry-run', 'apply'] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];
export type ObjectState = (typeof OBJECT_STATES)[number];
export type SnapshotSide = (typeof SNAPSHOT_SIDES)[number];
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type SyncMode = (typeof SYNC_MODES)[number];

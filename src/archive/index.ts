import { hostname } from 'node:os';
import type { Client as DiscordClient } from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import type { AddonLogger } from '../addons/isolation';
import { RepeatingTask } from '../addons/loop';
import type { LinkedGuild } from '../guild-sync/cycle';
import type { GuildSnapshot } from '../guild-sync/snapshot';
import { PostgresGuildSyncStore } from '../guild-sync/store';
import { listenToArchiveEdits } from './events';
import { FileFetcher } from './fileFetch';
import { DiskFileStore } from './files';
import { MemberSnapshots, describe } from './members';
import { discordArchiveSource } from './source';
import { PostgresArchiveStore } from './store';
import { dueChannels, targetsFrom } from './targets';
import { ArchiveUpkeep } from './upkeep';
import { ArchiveWalker } from './walker';

export const ADDON_NAME = 'archive';

/** 'bfar': the archive loop, apart from the history and sync locks. */
export const ARCHIVE_LOCK_KEY = 0x62666172;
/** A pass stops starting new work after this long (it holds the lock). */
export const ARCHIVE_PASS_MS = 60_000;
const MAX_LINKS_PER_PASS = 50;
const BUSY_DELAY_MS = 1_000;
const IDLE_DELAY_MS = 5 * 60_000;
/** Lets guild-sync take its first snapshot before the first pass. */
const FIRST_DELAY_MS = 90_000;

export interface ArchiveDeps {
    readonly discordClient: DiscordClient;
    readonly sequelize: Sequelize;
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly excludedChannels: ReadonlySet<string>;
    /** BF_ARCHIVE_DIR. */
    readonly dir: string;
    /** BF_ARCHIVE_MIN_FREE_GB, in bytes. */
    readonly minFreeBytes: number;
}

/** The pieces one pass uses, built once at start. */
export interface ArchiveParts {
    readonly store: Pick<
        PostgresArchiveStore,
        'ensureChannels' | 'channels' | 'totals'
    >;
    readonly snapshot: (linkId: string) => Promise<GuildSnapshot | null>;
    readonly walker: Pick<ArchiveWalker, 'walk'>;
    readonly upkeep: Pick<ArchiveUpkeep, 'retryFiles' | 'redactOptedOut'>;
    readonly logger: AddonLogger;
}

/**
 * Walks one guild's due channels until the deadline. Returns true when
 * work is left. Errors outside a walk (a database read) are logged and
 * retried next pass: thrown, they would trip the add-on boundary.
 */
async function archiveGuild(
    parts: ArchiveParts,
    deps: Pick<ArchiveDeps, 'excludedChannels'>,
    link: LinkedGuild,
    deadline: number,
    held: () => Promise<boolean>
): Promise<boolean> {
    const snapshot = await parts.snapshot(link.id);
    if (!snapshot) return false;
    const now = new Date();
    const targets = targetsFrom(snapshot, deps.excludedChannels);
    await parts.store.ensureChannels(targets, now);
    const due = dueChannels(
        await parts.store.channels(link.discordGuildId),
        targets,
        now
    );
    for (const channel of due) {
        if (Date.now() >= deadline || !(await held())) return true;
        const result = await parts.walker.walk(channel, deadline);
        if (result.more) return true;
    }
    return false;
}

/** One pass over every guild link, then retries and redactions. */
export async function archivePass(
    parts: ArchiveParts,
    deps: Pick<ArchiveDeps, 'excludedChannels' | 'listGuildLinks'>,
    held: () => Promise<boolean>
): Promise<boolean> {
    const deadline = Date.now() + ARCHIVE_PASS_MS;
    let more = false;
    const links = await deps.listGuildLinks();
    for (const link of links.slice(0, MAX_LINKS_PER_PASS)) {
        try {
            more =
                (await archiveGuild(parts, deps, link, deadline, held)) || more;
        } catch (error) {
            parts.logger.warn(
                `[archive] Pass over guild link ${link.id}: ${describe(error)}`
            );
        }
        if (Date.now() >= deadline) return true;
    }
    try {
        await parts.upkeep.redactOptedOut();
        await parts.upkeep.retryFiles(deadline);
    } catch (error) {
        parts.logger.warn(`[archive] Upkeep: ${describe(error)}`);
    }
    return more;
}

/** Builds the store, walker and upkeep over Discord and the volume. */
async function buildParts(
    deps: ArchiveDeps,
    context: AddonContext
): Promise<ArchiveParts & { upkeep: ArchiveUpkeep }> {
    const files = new DiskFileStore(deps.dir);
    await files.init();
    const store = new PostgresArchiveStore(deps.sequelize);
    const source = discordArchiveSource(deps.discordClient);
    const logger = context.logger;
    const now = () => new Date();
    const fetcher = new FileFetcher({
        store,
        files,
        minFreeBytes: deps.minFreeBytes,
        logger,
        now,
    });
    const members = new MemberSnapshots({ store, source, logger, now });
    const sync = new PostgresGuildSyncStore(deps.sequelize);
    return {
        store,
        snapshot: (id) => sync.lastSnapshot(id, 'discord', true),
        walker: new ArchiveWalker({
            store,
            source,
            members,
            fetcher,
            logger,
            now,
        }),
        upkeep: new ArchiveUpkeep({
            store,
            source,
            fetcher,
            files,
            logger,
            now,
        }),
        logger,
    };
}

/** Logs totals when a pass did work, at most every LOG_EVERY_MS. */
const LOG_EVERY_MS = 10 * 60_000;

function progressLogger(parts: ArchiveParts) {
    let last = 0;
    return async (): Promise<void> => {
        if (Date.now() - last < LOG_EVERY_MS) return;
        last = Date.now();
        const t = await parts.store.totals();
        parts.logger.info(
            `[archive] ${t.current}/${t.channels} channels current, ${t.messages} messages, ${t.stored} files (${(t.bytes / 1024 ** 3).toFixed(1)} GiB), ${t.pending} files to fetch`
        );
    };
}

/** The loop's pass: one archive pass under the archive lock. */
function lockedPass(
    deps: ArchiveDeps,
    context: AddonContext,
    parts: ArchiveParts
): () => Promise<boolean> {
    const holder = `${hostname()}:${process.pid}:archive`;
    const sync = new PostgresGuildSyncStore(deps.sequelize);
    const log = progressLogger(parts);
    return async () => {
        const result = await context.boundary.run(
            ADDON_NAME,
            'walk',
            async () => {
                const locked = await sync.withLeaderLock(
                    holder,
                    (held) => archivePass(parts, deps, held),
                    ARCHIVE_LOCK_KEY
                );
                await log();
                return locked.ran ? locked.value : false;
            }
        );
        return result.ok ? result.value : false;
    };
}

/**
 * The archive add-on: keeps a local copy of the linked Discord servers'
 * messages (as the API returns them), each author's name and avatars, and
 * the files messages carry. It only reads Discord and writes to bifrost's
 * database and its volume, so it runs in every mode.
 */
export function createArchiveAddon(deps: ArchiveDeps): Addon {
    let task: RepeatingTask | null = null;
    let stopEvents: (() => void) | null = null;
    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const parts = await buildParts(deps, context);
            stopEvents = listenToArchiveEdits(
                deps.discordClient,
                parts.upkeep,
                (task, fn) => context.boundary.handler(ADDON_NAME, task, fn)
            );
            task = new RepeatingTask(
                lockedPass(deps, context, parts),
                BUSY_DELAY_MS,
                IDLE_DELAY_MS
            );
            task.start(FIRST_DELAY_MS);
        },
        async stop() {
            stopEvents?.();
            stopEvents = null;
            await task?.stop();
            task = null;
        },
    };
}

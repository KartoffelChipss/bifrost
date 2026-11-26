import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Events, type Client as DiscordClient } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import type { AddonLogger } from '../addons/isolation';
import { DiscordAssetSource } from './assets';
import {
    resolveMode,
    runCycle,
    type CycleDeps,
    type CycleOutcome,
    type LinkedGuild,
} from './cycle';
import { CycleBackoff, guardCycle } from './cycleGuard';
import { MemoryFailureLedger } from './failures';
import { PostgresParkedMessages } from './parkedMessages';
import { ThreadMirror, type ThreadMirrorPorts } from './threadMirror';
import { excludedLinks, type ChannelLinker, type ThreadSource } from './links';
import { NoticeBoard } from './notices';
import { discordNoticeSender, discordStatusMessenger } from './notifier';
import { DiscordGuildReader } from './readers/discord';
import { FluxerGuildReader } from './readers/fluxer';
import { DEFAULT_SCHEDULE, SyncScheduler } from './scheduler';
import { PostgresHistoryStore } from '../history/store';
import { PostgresIdentityStore } from '../identity/store';
import { PostgresGuildSyncStore, type GuildSyncStore } from './store';
import { StatusBoard } from './statusBoard';
import type { StatusSignal } from './statusSignal';
import {
    followFluxerClient,
    listenToDiscordThreads,
    listenToFluxerThreads,
} from './threadEvents';
import { ThreadRelay, type ThreadRelayPorts } from './threadRelay';
import { ThreadResetRunner, type ThreadResetPort } from './threadResetJob';
import { FluxerGuildWriter, type FluxerWebhookSend } from './writers/fluxer';

export const ADDON_NAME = 'guild-sync';

/** Upper bound on guild links one run walks through. */
export const MAX_LINKS_PER_RUN = 50;

/** Snapshots are kept 30 days (design: Data model). */
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Discord events that schedule a cycle (design: Triggers). */
const SOURCE_EVENTS = [
    Events.ChannelCreate,
    Events.ChannelUpdate,
    Events.ChannelDelete,
    Events.GuildRoleCreate,
    Events.GuildRoleUpdate,
    Events.GuildRoleDelete,
    Events.GuildEmojiCreate,
    Events.GuildEmojiUpdate,
    Events.GuildEmojiDelete,
    Events.GuildStickerCreate,
    Events.GuildStickerUpdate,
    Events.GuildStickerDelete,
    Events.GuildUpdate,
    Events.ThreadCreate,
    Events.ThreadUpdate,
    Events.ThreadDelete,
] as const;

export interface GuildSyncDeps {
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    /** True for a Discord channel the relay bridges. */
    readonly isChannelLinked: (discordChannelId: string) => Promise<boolean>;
    readonly commandPrefix: string;
    readonly sequelize: Sequelize;
    /** Upstream's links, webhooks and message formatting (upstreamBridge.ts). */
    readonly bridge: GuildSyncBridge;
    /** History import is on: text channels wait for it, replies are held. */
    readonly historyEnabled: boolean;
    /** Discord channel or category IDs never synced. */
    readonly excludedChannels: ReadonlySet<string>;
    /** Account linking is on: member overwrites follow linked members. */
    readonly identityEnabled?: boolean;
    /** History passes and admin commands ask for a status update here. */
    readonly statusSignal?: StatusSignal;
    /** `sync reset-threads` reaches guild-sync's reset runner here. */
    readonly threadReset?: ThreadResetPort;
}

/** Linked accounts, Discord user ID to Fluxer user ID. */
function linkedMembers(sequelize: Sequelize) {
    const store = new PostgresIdentityStore(sequelize);
    return async () =>
        new Map(
            (await store.listPairs()).map((pair) => [
                pair.discordUserId,
                pair.fluxerUserId,
            ])
        );
}

export type GuildSyncBridge = ChannelLinker &
    ThreadSource &
    ThreadRelayPorts &
    ThreadMirrorPorts & { readonly sendViaFluxerWebhook: FluxerWebhookSend };

/** The links one run walks through, bounded by MAX_LINKS_PER_RUN. */
async function linksToSync(
    deps: GuildSyncDeps,
    cycleDeps: CycleDeps
): Promise<readonly LinkedGuild[]> {
    const links = await deps.listGuildLinks();
    if (links.length > MAX_LINKS_PER_RUN) {
        cycleDeps.logger.warn(
            `[guild-sync] ${links.length} guild links; syncing the first ${MAX_LINKS_PER_RUN}`
        );
    }
    return links.slice(0, MAX_LINKS_PER_RUN);
}

/** What a link's cycle did; null when it failed. */
export type CycleObserver = (
    guildLinkId: string,
    outcome: CycleOutcome | null
) => void;

/**
 * Runs one cycle per linked guild while holding the leader lock. Returns
 * true when an applied plan left ops for the next cycle. A link whose
 * cycle fails backs off alone; the other links still run (cycleGuard.ts).
 * `observe` hears every link's result, for the status message.
 */
export async function runAll(
    store: GuildSyncStore,
    deps: GuildSyncDeps,
    cycleDeps: CycleDeps,
    holder: string,
    backoff: CycleBackoff,
    observe: CycleObserver = () => {}
): Promise<boolean> {
    let more = false;
    const guard = { backoff, now: cycleDeps.now, logger: cycleDeps.logger };
    const result = await store.withLeaderLock(holder, async (held) => {
        for (const link of await linksToSync(deps, cycleDeps)) {
            const outcome = await guardCycle(`link ${link.id}`, guard, () =>
                runCycle(link, { ...cycleDeps, stillLeader: held })
            );
            observe(link.id, outcome.ok ? outcome.value : null);
            if (!outcome.ok) continue;
            if (outcome.value.status === 'planned' && outcome.value.more) {
                more = true;
            }
        }
        const now = cycleDeps.now().getTime();
        await store.pruneSnapshots(new Date(now - SNAPSHOT_RETENTION_MS));
        await store.prunePlans(new Date(now - SNAPSHOT_RETENTION_MS));
        await store.pruneTombstoned(cycleDeps.now());
    });
    if (!result.ran) {
        cycleDeps.logger.info(
            '[guild-sync] Another instance holds the leader lock'
        );
    }
    return more;
}

const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Text channels whose history is copied, or that gave up, may be bridged. */
function historyReady(store: PostgresHistoryStore) {
    // Completed imports only: a failed one waits for `history retry`
    // rather than being bridged with part of its history. Channels in
    // archive-thread mode are ready at once (history/store.ts).
    return (linkId: string) => store.channelsReadyToBridge(linkId);
}

/** What a cycle needs: the store, both platforms and the clock. */
function buildCycleDeps(
    deps: GuildSyncDeps,
    context: AddonContext,
    store: GuildSyncStore
): CycleDeps {
    return {
        store,
        readers: {
            discord: new DiscordGuildReader(deps.discordClient),
            fluxer: new FluxerGuildReader(deps.fluxerClientRef),
        },
        writers: {
            fluxer: new FluxerGuildWriter(
                deps.fluxerClientRef,
                deps.bridge.sendViaFluxerWebhook,
                (message) => context.logger.warn(message)
            ),
        },
        assets: {
            discord: new DiscordAssetSource(deps.discordClient),
        },
        links: deps.bridge,
        excludedChannels: deps.excludedChannels,
        historyReady: deps.historyEnabled
            ? historyReady(new PostgresHistoryStore(deps.sequelize))
            : undefined,
        threadSources: { discord: deps.bridge },
        notices: new NoticeBoard(
            discordNoticeSender(deps.discordClient, deps.isChannelLinked),
            context.logger
        ),
        commandPrefix: deps.commandPrefix,
        processMode: () => context.mode.mode,
        allowApply: context.allowApply,
        pause,
        logger: context.logger,
        now: () => new Date(),
        newId: randomUUID,
        failures: new MemoryFailureLedger(),
        lookups: new Map(),
        linkedMembers: deps.identityEnabled
            ? linkedMembers(deps.sequelize)
            : undefined,
    };
}

/** The live status message board for every link (statusBoard.ts). */
function createStatusBoard(
    deps: GuildSyncDeps,
    context: AddonContext,
    store: GuildSyncStore
): StatusBoard {
    const history = deps.historyEnabled
        ? new PostgresHistoryStore(deps.sequelize)
        : null;
    return new StatusBoard({
        store,
        messenger: discordStatusMessenger(
            deps.discordClient,
            deps.isChannelLinked
        ),
        historyTotals: history ? (id) => history.jobTotals(id) : undefined,
        processMode: () => context.mode.mode,
        allowApply: context.allowApply,
        commandPrefix: deps.commandPrefix,
        now: () => new Date(),
        logger: context.logger,
    });
}

/** How long stopping waits for thread relay work in flight. */
export const RELAY_STOP_TIMEOUT_MS = 5_000;

/**
 * Whether the thread mirror may create a Discord thread for a link.
 * Creating one is a structure write: apply mode only, and only while
 * Discord is the source, so the new thread is a source object.
 */
export function mirrorMayWrite(
    store: Pick<GuildSyncStore, 'loadSettings'>,
    context: Pick<AddonContext, 'mode' | 'allowApply'>
): (guildLinkId: string) => Promise<boolean> {
    return async (linkId) => {
        const settings = await store.loadSettings(linkId);
        if (settings.direction !== 'discord-to-fluxer') return false;
        const mode = resolveMode(
            context.mode.mode,
            settings,
            context.allowApply
        );
        return mode.mode === 'apply';
    };
}

/** How often a channel whose category cannot be read is logged again. */
export const CATEGORY_WARN_INTERVAL_MS = 60 * 60_000;

/** Upper bound on channels remembered as logged; past it, all are forgotten. */
export const MAX_CATEGORY_WARNINGS = 1_000;

/**
 * True when `key` was not let through in the last `intervalMs`, and
 * remembers that it now was. Bounded by MAX_CATEGORY_WARNINGS keys.
 */
function oncePerInterval(intervalMs: number, now: () => Date) {
    const last = new Map<string, number>();
    return (key: string): boolean => {
        const at = now().getTime();
        const before = last.get(key);
        if (before !== undefined && at - before < intervalMs) return false;
        if (last.size >= MAX_CATEGORY_WARNINGS) last.clear();
        last.set(key, at);
        return true;
    };
}

/**
 * The category of a Discord channel, or null. A channel that cannot be
 * fetched has no category, so its link is excluded only when the channel
 * itself is listed; the failure is logged once per channel per interval.
 */
export function discordCategory(
    client: Pick<DiscordClient, 'channels'>,
    logger: AddonLogger,
    now: () => Date = () => new Date()
) {
    const shouldWarn = oncePerInterval(CATEGORY_WARN_INTERVAL_MS, now);
    return async (channelId: string): Promise<string | null> => {
        try {
            const channel =
                client.channels.cache.get(channelId) ??
                (await client.channels.fetch(channelId));
            return channel && 'parentId' in channel ? channel.parentId : null;
        } catch (error) {
            if (shouldWarn(channelId)) {
                const detail = error instanceof Error ? error.message : error;
                logger.warn(
                    `[guild-sync] Could not read the category of Discord channel ${channelId}; only an exclusion of the channel itself applies to it: ${String(detail)}`
                );
            }
            return null;
        }
    };
}

/** Starts the relay for messages inside threads. Returns its stop function. */
function startThreadRelay(
    deps: GuildSyncDeps,
    context: AddonContext,
    store: PostgresGuildSyncStore
): { relay: ThreadRelay; stop: () => Promise<void> } {
    const mirror = new ThreadMirror({
        store,
        ports: deps.bridge,
        mayWrite: mirrorMayWrite(store, context),
        // A private thread's copy gets its members' linked accounts.
        linkedAccounts: deps.identityEnabled
            ? linkedMembers(deps.sequelize)
            : undefined,
        now: () => new Date(),
        logger: context.logger,
    });
    const relay = new ThreadRelay({
        store,
        links: deps.bridge,
        ports: deps.bridge,
        active: () => context.mode.mode !== 'read-only',
        importing: deps.historyEnabled
            ? (id) =>
                  new PostgresHistoryStore(deps.sequelize).threadImporting(id)
            : undefined,
        isArchiveThread: deps.historyEnabled
            ? (id) =>
                  new PostgresHistoryStore(deps.sequelize).isArchiveThread(id)
            : undefined,
        mirror: (link, event, raw) => mirror.mirror(link, event, raw),
        // Held replies survive a restart (addon_parked_messages).
        parked: new PostgresParkedMessages(deps.sequelize),
        // Excluded channels are never bridged, even while a link remains.
        excluded: excludedLinks(
            deps.excludedChannels,
            discordCategory(deps.discordClient, context.logger)
        ),
        now: () => new Date(),
        logger: context.logger,
    });
    const wrap = <A extends unknown[]>(
        task: string,
        fn: (...args: A) => Promise<void> | void
    ) => context.boundary.handler(ADDON_NAME, task, fn);
    const stopDiscord = listenToDiscordThreads(deps.discordClient, relay, wrap);
    const stopFluxer = followFluxerClient(deps.fluxerClientRef, (client) =>
        listenToFluxerThreads(client, relay, wrap)
    );
    return {
        relay,
        stop: async () => {
            stopDiscord();
            stopFluxer();
            const idle = await relay.stop(RELAY_STOP_TIMEOUT_MS);
            if (!idle) {
                context.logger.warn(
                    `[guild-sync] Thread relay work still running after ${RELAY_STOP_TIMEOUT_MS} ms; stopping anyway`
                );
            }
        },
    };
}

/**
 * Attaches the runner for `sync reset-threads`. Returns its stop function.
 * `after` hears when a reset ended, for the status and the next cycle.
 */
function startThreadResets(
    deps: GuildSyncDeps,
    context: AddonContext,
    cycleDeps: CycleDeps,
    holder: string,
    after: (guildLinkId: string) => void
): () => Promise<void> {
    const writer = cycleDeps.writers.fluxer;
    if (!deps.threadReset || !writer) return async () => {};
    const runner = new ThreadResetRunner({
        store: cycleDeps.store,
        writer,
        notices: cycleDeps.notices,
        processMode: cycleDeps.processMode,
        allowApply: cycleDeps.allowApply,
        holder: `${holder}:thread-reset`,
        isolate: (run) => context.boundary.run(ADDON_NAME, 'thread-reset', run),
        changed: after,
        pause,
        now: cycleDeps.now,
        newId: cycleDeps.newId,
        logger: context.logger,
    });
    const detach = deps.threadReset.attach(runner);
    return async () => {
        detach();
        if (!(await runner.stop())) {
            context.logger.warn(
                '[guild-sync] A thread reset was still running; it stops after its current thread'
            );
        }
    };
}

/**
 * The guild-sync add-on. Every cycle saves a plan and logs its summary. A
 * plan is applied only when the environment allows apply and an admin set
 * the link to apply. Structure is written only to Fluxer. Messages inside
 * synced threads are relayed both ways.
 */
export function createGuildSyncAddon(deps: GuildSyncDeps): Addon {
    let scheduler: SyncScheduler | null = null;
    let listener: ((...args: unknown[]) => void) | null = null;
    let stopRelay: (() => Promise<void>) | null = null;
    let status: StatusBoard | null = null;
    let stopListening: (() => void) | null = null;
    let stopResets: (() => Promise<void>) | null = null;

    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const store = new PostgresGuildSyncStore(deps.sequelize);
            const cycleDeps = buildCycleDeps(deps, context, store);
            const holder = `${hostname()}:${process.pid}`;
            const threads = startThreadRelay(deps, context, store);
            stopRelay = threads.stop;
            const board = createStatusBoard(deps, context, store);
            status = board;
            stopListening =
                deps.statusSignal?.listen((id) => board.request(id)) ?? null;
            const observe = (id: string, outcome: CycleOutcome | null) =>
                board.recordCycle(id, outcome);
            const backoff = new CycleBackoff();
            const guard = {
                backoff,
                now: cycleDeps.now,
                logger: context.logger,
            };
            // Declared first: a cycle that leaves work asks for the next one.
            // Only an OwnershipLostError reaches the boundary and trips
            // read-only; other errors back off (cycleGuard.ts).
            const active: SyncScheduler = new SyncScheduler(async () => {
                const result = await context.boundary.run(
                    ADDON_NAME,
                    'cycle',
                    async () => {
                        const run = await guardCycle('run', guard, () =>
                            runAll(
                                store,
                                deps,
                                cycleDeps,
                                holder,
                                backoff,
                                observe
                            )
                        );
                        // A cycle may have created threads that held messages.
                        await threads.relay.flush();
                        return run.ok && run.value;
                    }
                );
                if (result.ok && result.value) active.notify();
            }, DEFAULT_SCHEDULE);
            stopResets = startThreadResets(
                deps,
                context,
                cycleDeps,
                holder,
                (id) => {
                    board.request(id);
                    active.notify();
                }
            );
            listener = context.boundary.handler(ADDON_NAME, 'event', () =>
                active.notify()
            );
            for (const event of SOURCE_EVENTS)
                deps.discordClient.on(event, listener);
            scheduler = active;
            active.start();
        },
        async stop() {
            if (listener) {
                for (const event of SOURCE_EVENTS)
                    deps.discordClient.off(event, listener);
            }
            listener = null;
            stopListening?.();
            stopListening = null;
            const relayStopped = stopRelay?.();
            stopRelay = null;
            const resetsStopped = stopResets?.();
            stopResets = null;
            // All wait together, within the host's stop deadline. The
            // status board clears its timers at once.
            await Promise.all([
                relayStopped,
                resetsStopped,
                scheduler?.stop(),
                status?.stop(),
            ]);
            scheduler = null;
            status = null;
        },
    };
}

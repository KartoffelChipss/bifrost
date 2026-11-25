import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Events, type Client as DiscordClient } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import { DiscordAssetSource } from './assets';
import { runCycle, type CycleDeps, type LinkedGuild } from './cycle';
import type { ChannelLinker, ThreadSource } from './links';
import { NoticeBoard } from './notices';
import { discordNoticeSender } from './notifier';
import { DiscordGuildReader } from './readers/discord';
import { FluxerGuildReader } from './readers/fluxer';
import { DEFAULT_SCHEDULE, SyncScheduler } from './scheduler';
import { PostgresHistoryStore } from '../history/store';
import { PostgresGuildSyncStore, type GuildSyncStore } from './store';
import {
    followFluxerClient,
    listenToDiscordThreads,
    listenToFluxerThreads,
} from './threadEvents';
import { ThreadRelay, type ThreadRelayPorts } from './threadRelay';
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
}

export type GuildSyncBridge = ChannelLinker &
    ThreadSource &
    ThreadRelayPorts & { readonly sendViaFluxerWebhook: FluxerWebhookSend };

/**
 * Runs one cycle per linked guild while holding the leader lock. Returns
 * true when an applied plan left ops for the next cycle.
 */
async function runAll(
    store: GuildSyncStore,
    deps: GuildSyncDeps,
    cycleDeps: CycleDeps,
    holder: string
): Promise<boolean> {
    let more = false;
    const result = await store.withLeaderLock(holder, async () => {
        const links = await deps.listGuildLinks();
        if (links.length > MAX_LINKS_PER_RUN) {
            cycleDeps.logger.warn(
                `[guild-sync] ${links.length} guild links; syncing the first ${MAX_LINKS_PER_RUN}`
            );
        }
        for (const link of links.slice(0, MAX_LINKS_PER_RUN)) {
            const outcome = await runCycle(link, cycleDeps);
            if (outcome.status === 'planned' && outcome.more) more = true;
        }
        await store.pruneSnapshots(
            new Date(cycleDeps.now().getTime() - SNAPSHOT_RETENTION_MS)
        );
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
    return async (linkId: string): Promise<ReadonlySet<string>> => {
        const jobs = await store.listJobs(linkId);
        return new Set(
            jobs
                .filter((j) => j.kind === 'channel')
                .filter((j) => ['ready', 'done', 'failed'].includes(j.status))
                .map((j) => j.discordId)
        );
    };
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
                deps.bridge.sendViaFluxerWebhook
            ),
        },
        assets: {
            discord: new DiscordAssetSource(deps.discordClient),
        },
        links: deps.bridge,
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
    };
}

/** Starts the relay for messages inside threads. Returns its stop function. */
function startThreadRelay(
    deps: GuildSyncDeps,
    context: AddonContext,
    store: PostgresGuildSyncStore
): { relay: ThreadRelay; stop: () => void } {
    const relay = new ThreadRelay({
        store,
        links: deps.bridge,
        ports: deps.bridge,
        active: () => context.mode.mode !== 'read-only',
        importing: deps.historyEnabled
            ? (id) =>
                  new PostgresHistoryStore(deps.sequelize).threadImporting(id)
            : undefined,
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
        stop: () => {
            stopDiscord();
            stopFluxer();
        },
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
    let stopRelay: (() => void) | null = null;

    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const store = new PostgresGuildSyncStore(deps.sequelize);
            const cycleDeps = buildCycleDeps(deps, context, store);
            const holder = `${hostname()}:${process.pid}`;
            const threads = startThreadRelay(deps, context, store);
            stopRelay = threads.stop;
            // Declared first: a cycle that leaves work asks for the next one.
            const active: SyncScheduler = new SyncScheduler(async () => {
                const result = await context.boundary.run(
                    ADDON_NAME,
                    'cycle',
                    async () => {
                        const more = await runAll(
                            store,
                            deps,
                            cycleDeps,
                            holder
                        );
                        // A cycle may have created threads that held messages.
                        await threads.relay.flush();
                        return more;
                    }
                );
                if (result.ok && result.value) active.notify();
            }, DEFAULT_SCHEDULE);
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
            stopRelay?.();
            stopRelay = null;
            await scheduler?.stop();
            scheduler = null;
        },
    };
}

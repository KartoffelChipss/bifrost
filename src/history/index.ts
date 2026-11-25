import { hostname } from 'node:os';
import type { Client as DiscordClient } from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import type { AddonLogger } from '../addons/isolation';
import { RepeatingTask } from '../addons/loop';
import { resolveMode, type LinkedGuild } from '../guild-sync/cycle';
import type { ChannelLinker } from '../guild-sync/links';
import { NoticeBoard, type SendNotice } from '../guild-sync/notices';
import { HISTORY_LOCK_KEY, PostgresGuildSyncStore } from '../guild-sync/store';
import type { GuildWriter } from '../guild-sync/writers/writer';
import { HistoryEditor, type EditorThreads } from './editor';
import { listenToDiscordEdits } from './events';
import { CopyFormatter } from './format';
import { HistoryImporter, type HistoryMode } from './importer';
import { PASS_BUDGET_MS } from './limits';
import { HistoryMirror } from './mirror';
import { PostgresHistoryStore } from './store';
import type { HistoryPorts } from './types';

export const ADDON_NAME = 'history';

/** Upper bound on guild links one pass walks through. */
const MAX_LINKS_PER_PASS = 50;
const BUSY_DELAY_MS = 1_000;
const IDLE_DELAY_MS = 5 * 60_000;
/** Polling while a job waits out a backoff or for its channel's bridge. */
export const WAIT_POLL_MS = 10_000;
/** Lets guild-sync take its first snapshot before the first pass. */
const FIRST_DELAY_MS = 60_000;

export interface HistoryDeps {
    readonly discordClient: DiscordClient;
    readonly sequelize: Sequelize;
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly links: ChannelLinker;
    readonly ports: HistoryPorts;
    readonly writer: Pick<GuildWriter, 'updateThread' | 'createThread'>;
    /** BF_HISTORY_INLINE_MAX: see ImporterDeps.inlineMax. */
    readonly inlineMax?: number;
    readonly sendNotice: SendNotice;
    readonly excludedChannels: ReadonlySet<string>;
    /** Upstream's command prefix, which copies must not start with. */
    readonly commandPrefix: string;
}

type Sync = PostgresGuildSyncStore;

const IDLE: PassResult = { more: false, waiting: false };

const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/** History is copied from Discord to Fluxer only, and written in apply. */
function modeOf(sync: Sync, context: AddonContext) {
    return async (linkId: string): Promise<HistoryMode> => {
        const settings = await sync.loadSettings(linkId);
        if (settings.direction !== 'discord-to-fluxer') return 'read-only';
        return resolveMode(context.mode.mode, settings, context.allowApply)
            .mode;
    };
}

/** Keeps guild-sync's record of a thread in step with what history wrote. */
function threadStateRecorder(sync: Sync) {
    return async (
        linkId: string,
        discordThreadId: string,
        state: { archived: boolean; locked: boolean }
    ): Promise<void> => {
        const rows = await sync.loadObjectMap(linkId);
        const row = rows.find(
            (r) =>
                r.kind === 'thread' &&
                r.state === 'active' &&
                r.discordId === discordThreadId
        );
        if (!row) return;
        const fields = { ...(row.appliedFields ?? {}), ...state };
        await sync.saveApplied(row.id, fields, new Date());
    };
}

function buildImporter(deps: HistoryDeps, context: AddonContext) {
    const sync = new PostgresGuildSyncStore(deps.sequelize);
    const notices = new NoticeBoard(deps.sendNotice, context.logger);
    const importer = new HistoryImporter({
        store: new PostgresHistoryStore(deps.sequelize),
        sync: {
            lastSnapshot: (id) => sync.lastSnapshot(id, 'discord', true),
            loadObjectMap: (id) => sync.loadObjectMap(id),
        },
        ports: deps.ports,
        links: deps.links,
        writer: deps.writer,
        inlineMax: deps.inlineMax,
        recordThreadState: threadStateRecorder(sync),
        excluded: deps.excludedChannels,
        adminChannel: async (id) =>
            (await sync.loadSettings(id)).adminChannelId,
        commandPrefix: deps.commandPrefix,
        mode: modeOf(sync, context),
        report: async (id, key, text) => {
            const settings = await sync.loadSettings(id);
            await notices.post(
                `history:${id}`,
                settings.adminChannelId,
                key,
                text
            );
        },
        pause,
        now: () => new Date(),
        logger: context.logger,
    });
    return { sync, importer };
}

/** Opens and closes Fluxer threads around edits of copies inside them. */
export function editorThreads(
    deps: Pick<HistoryDeps, 'listGuildLinks' | 'ports' | 'writer'>
): EditorThreads {
    return {
        discordState: (id) => deps.ports.threadState(id),
        setState: async (linkId, threadId, state) => {
            const links = await deps.listGuildLinks();
            const link = links.find((l) => l.id === linkId);
            if (!link) throw new Error(`guild link ${linkId} is gone`);
            await deps.writer.updateThread(link.fluxerGuildId, threadId, state);
        },
    };
}

/** Mirrors Discord edits and deletes of imported messages. */
function startMirror(deps: HistoryDeps, context: AddonContext, sync: Sync) {
    const store = new PostgresHistoryStore(deps.sequelize);
    const mirror = new HistoryMirror({
        store,
        editor: new HistoryEditor(
            store,
            deps.links,
            deps.ports,
            editorThreads(deps)
        ),
        formatter: new CopyFormatter({
            store,
            ports: deps.ports,
            commandPrefix: deps.commandPrefix,
        }),
        ports: deps.ports,
        mode: modeOf(sync, context),
        logger: context.logger,
    });
    const wrap = <A extends unknown[]>(
        task: string,
        fn: (...args: A) => Promise<void> | void
    ) => context.boundary.handler(ADDON_NAME, task, fn);
    return listenToDiscordEdits(deps.discordClient, mirror, wrap);
}

/** What one pass found: work left now, or a job waiting for a time. */
export interface PassResult {
    readonly more: boolean;
    readonly waiting: boolean;
}

/**
 * Runs the importer for one link. An error outside any job, such as a
 * database or snapshot read, is logged and retried soon: at the add-on
 * boundary it would switch every add-on to read-only.
 */
async function importLink(
    importer: HistoryImporter,
    link: LinkedGuild,
    deadline: number,
    logger: AddonLogger,
    held: () => Promise<boolean>
): Promise<PassResult> {
    try {
        if (await importer.run(link, deadline, held))
            return { more: true, waiting: false };
        return { more: false, waiting: await importer.waiting(link.id) };
    } catch (error) {
        logger.warn(`[history] Pass over guild link ${link.id}:`, error);
        return { more: false, waiting: true };
    }
}

/**
 * Runs the importer for each guild link until the pass budget is spent,
 * which keeps the leader lock's transaction short. `held` reports whether
 * the leader lock is still held; once it is lost, no new work starts, so
 * two instances never copy at once.
 */
export async function importLinks(
    deps: Pick<HistoryDeps, 'listGuildLinks'>,
    importer: HistoryImporter,
    logger: AddonLogger,
    held: () => Promise<boolean> = async () => true
): Promise<PassResult> {
    const deadline = Date.now() + PASS_BUDGET_MS;
    const links = await deps.listGuildLinks();
    let more = false;
    let waiting = false;
    for (const link of links.slice(0, MAX_LINKS_PER_PASS)) {
        if (Date.now() >= deadline) return { more: true, waiting };
        if (!(await held())) return IDLE;
        const result = await importLink(importer, link, deadline, logger, held);
        more = more || result.more;
        waiting = waiting || result.waiting;
    }
    return { more, waiting };
}

/**
 * Turns pass results into the loop's busy or idle answer. While a job
 * waits, the loop ticks busy but runs a real pass only every WAIT_POLL_MS.
 */
export class WaitThrottle {
    private quietUntil = 0;

    constructor(private readonly now: () => number) {}

    /** True when this tick should skip the real pass. */
    resting(): boolean {
        return this.now() < this.quietUntil;
    }

    /** The loop's answer after a real pass. */
    after(result: PassResult): boolean {
        if (result.more) return true;
        if (!result.waiting) return false;
        this.quietUntil = this.now() + WAIT_POLL_MS;
        return true;
    }
}

/**
 * The history add-on: copies past Discord messages into the synced
 * channels, posts and threads, and carries later Discord edits and
 * deletes over to those copies. In dry-run it only counts them.
 */
export function createHistoryAddon(deps: HistoryDeps): Addon {
    let task: RepeatingTask | null = null;
    let stopMirror: (() => void) | null = null;
    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const { sync, importer } = buildImporter(deps, context);
            stopMirror = startMirror(deps, context, sync);
            const optOuts = new PostgresHistoryStore(deps.sequelize);
            deps.ports.useOptOuts?.((id) => optOuts.isOptedOut(id));
            const holder = `${hostname()}:${process.pid}:history`;
            const throttle = new WaitThrottle(() => Date.now());
            const pass = async () => {
                if (throttle.resting()) return true;
                const result = await context.boundary.run(
                    ADDON_NAME,
                    'import',
                    async () => {
                        const locked = await sync.withLeaderLock(
                            holder,
                            (held) =>
                                importLinks(
                                    deps,
                                    importer,
                                    context.logger,
                                    held
                                ),
                            HISTORY_LOCK_KEY
                        );
                        return locked.ran ? locked.value : IDLE;
                    }
                );
                return throttle.after(result.ok ? result.value : IDLE);
            };
            task = new RepeatingTask(pass, BUSY_DELAY_MS, IDLE_DELAY_MS);
            task.start(FIRST_DELAY_MS);
        },
        async stop() {
            deps.ports.useOptOuts?.(null);
            stopMirror?.();
            stopMirror = null;
            await task?.stop();
            task = null;
        },
    };
}

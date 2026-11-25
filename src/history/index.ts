import { hostname } from 'node:os';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import { RepeatingTask } from '../addons/loop';
import { resolveMode, type LinkedGuild } from '../guild-sync/cycle';
import type { ChannelLinker } from '../guild-sync/links';
import { NoticeBoard, type SendNotice } from '../guild-sync/notices';
import { HISTORY_LOCK_KEY, PostgresGuildSyncStore } from '../guild-sync/store';
import type { GuildWriter } from '../guild-sync/writers/writer';
import { HistoryImporter } from './importer';
import { PostgresHistoryStore } from './store';
import type { HistoryPorts } from './types';

export const ADDON_NAME = 'history';

/** Upper bound on guild links one pass walks through. */
const MAX_LINKS_PER_PASS = 50;
const BUSY_DELAY_MS = 1_000;
const IDLE_DELAY_MS = 5 * 60_000;
/** Lets guild-sync take its first snapshot before the first pass. */
const FIRST_DELAY_MS = 60_000;

export interface HistoryDeps {
    readonly sequelize: Sequelize;
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly links: ChannelLinker;
    readonly ports: HistoryPorts;
    readonly writer: Pick<GuildWriter, 'updateThread'>;
    readonly sendNotice: SendNotice;
}

const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

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
        mode: async (id) => {
            const settings = await sync.loadSettings(id);
            // History is copied from Discord to Fluxer only.
            if (settings.direction !== 'discord-to-fluxer') return 'read-only';
            return resolveMode(context.mode.mode, settings, context.allowApply)
                .mode;
        },
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

/**
 * The history add-on: copies past Discord messages into the synced
 * channels, posts and threads. In dry-run it only counts them.
 */
export function createHistoryAddon(deps: HistoryDeps): Addon {
    let task: RepeatingTask | null = null;
    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const { sync, importer } = buildImporter(deps, context);
            const holder = `${hostname()}:${process.pid}:history`;
            const pass = async () => {
                const result = await context.boundary.run(
                    ADDON_NAME,
                    'import',
                    async () => {
                        const locked = await sync.withLeaderLock(
                            holder,
                            async () => {
                                let more = false;
                                const links = await deps.listGuildLinks();
                                for (const link of links.slice(
                                    0,
                                    MAX_LINKS_PER_PASS
                                )) {
                                    if (await importer.run(link)) more = true;
                                }
                                return more;
                            },
                            HISTORY_LOCK_KEY
                        );
                        return locked.ran && locked.value;
                    }
                );
                return result.ok && result.value;
            };
            task = new RepeatingTask(pass, BUSY_DELAY_MS, IDLE_DELAY_MS);
            task.start(FIRST_DELAY_MS);
        },
        async stop() {
            await task?.stop();
            task = null;
        },
    };
}

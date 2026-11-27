import { Routes, type Client as FluxerClient } from '@fluxerjs/core';
import {
    Events,
    type Client as DiscordClient,
    type GuildMember,
    type PartialGuildMember,
    type PartialUser,
    type User,
} from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import type { AddonLogger } from '../addons/isolation';
import { RepeatingTask } from '../addons/loop';
import { resolveMode, type LinkedGuild } from '../guild-sync/cycle';
import { isNotFound } from '../guild-sync/notFound';
import { PostgresGuildSyncStore } from '../guild-sync/store';
import {
    openFluxerDb,
    type FluxerDb,
    type FluxerDbSettings,
} from '../fluxer-db/pool';
import type { DiscordNames } from './names';
import { PostgresNameStore, type CopyRef } from './store';
import { NameSync, describe, type LinkRef, type NameSyncPorts } from './sync';
import { FluxerNameWriter } from './writer';

export const ADDON_NAME = 'name-sync';
const MAX_LINKS_PER_PASS = 50;
const BUSY_DELAY_MS = 2_000;
const IDLE_DELAY_MS = 60_000;
/** Authors are looked for again this often, to pick up new ones. */
const SEED_EVERY_MS = 60 * 60_000;
/** Lets the other add-ons start first. */
const FIRST_DELAY_MS = 120_000;
/** Sendable message flags (Fluxer packages/constants ChannelConstants.ts:132). */
const SENDABLE_FLAGS = (1 << 2) | (1 << 12) | (1 << 13);

export interface NameSyncAddonDeps {
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly sequelize: Sequelize;
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly fluxerDb: FluxerDbSettings;
}

/** The member's names now: as a member, else from their user profile. */
export async function discordNames(
    client: DiscordClient,
    guildId: string,
    userId: string
): Promise<DiscordNames | null> {
    try {
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        return {
            nick: member.nickname ?? null,
            globalName: member.user.globalName ?? null,
            username: member.user.username,
        };
    } catch (error) {
        if (!isNotFound(error)) throw error;
    }
    try {
        const user = await client.users.fetch(userId);
        return {
            nick: null,
            globalName: user.globalName ?? null,
            username: user.username,
        };
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

function fluxerPorts(deps: NameSyncAddonDeps): NameSyncPorts {
    const fluxer = (): FluxerClient => {
        const client = deps.fluxerClientRef.current;
        if (!client?.isReady()) throw new Error('Fluxer gateway is not ready');
        return client;
    };
    return {
        names: (guildId, userId) =>
            discordNames(deps.discordClient, guildId, userId),
        refresh: async (copy: CopyRef) => {
            if (!copy.webhookId || !copy.webhookToken) return;
            const route = `${Routes.webhookExecute(copy.webhookId, copy.webhookToken)}/messages/${copy.messageId}`;
            const current = (await fluxer().rest.get(route, {
                auth: false,
            })) as {
                flags?: unknown;
            };
            const flags = typeof current.flags === 'number' ? current.flags : 0;
            await fluxer().rest.patch(route, {
                body: { flags: flags & SENDABLE_FLAGS },
                auth: false,
            });
        },
    };
}

/** Links whose writes are on: name sync only changes copies in apply. */
async function applyLinks(
    deps: NameSyncAddonDeps,
    sync: PostgresGuildSyncStore,
    context: AddonContext
): Promise<LinkRef[]> {
    const links = (await deps.listGuildLinks()).slice(0, MAX_LINKS_PER_PASS);
    const out: LinkRef[] = [];
    for (const link of links) {
        const settings = await sync.loadSettings(link.id);
        if (settings.direction !== 'discord-to-fluxer') continue;
        const { mode } = resolveMode(
            context.mode.mode,
            settings,
            context.allowApply
        );
        if (mode === 'apply')
            out.push({ id: link.id, discordGuildId: link.discordGuildId });
    }
    return out;
}

function memberChanged(
    before: GuildMember | PartialGuildMember,
    after: GuildMember
): boolean {
    return before.partial || before.nickname !== after.nickname;
}

function userChanged(before: User | PartialUser, after: User): boolean {
    return (
        before.partial ||
        before.globalName !== after.globalName ||
        before.username !== after.username
    );
}

/**
 * Name sync: when a Discord member's name changes, every Fluxer copy of
 * their messages shows the new name (docs/design/history-rewrite.md).
 */
export function createNameSyncAddon(deps: NameSyncAddonDeps): Addon {
    let db: FluxerDb | null = null;
    let task: RepeatingTask | null = null;
    let detach: (() => void) | null = null;

    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const logger: AddonLogger = context.logger;
            db = openFluxerDb(deps.fluxerDb, 'bifrost-name-sync');
            const writer = new FluxerNameWriter(db);
            await writer.check();
            const store = new PostgresNameStore(deps.sequelize);
            const sync = new PostgresGuildSyncStore(deps.sequelize);
            const names = new NameSync({
                store,
                writer,
                ports: fluxerPorts(deps),
                logger,
                now: () => new Date(),
            });
            detach = listen(deps.discordClient, store, logger);
            let seededAt = 0;
            task = new RepeatingTask(
                async () => {
                    const links = await applyLinks(deps, sync, context);
                    const seed = Date.now() - seededAt > SEED_EVERY_MS;
                    let more = false;
                    for (const link of links) {
                        if (seed)
                            await store.seed(link.discordGuildId, link.id);
                        more = (await names.pass(link)) || more;
                    }
                    if (seed && links.length > 0) seededAt = Date.now();
                    return more;
                },
                BUSY_DELAY_MS,
                IDLE_DELAY_MS
            );
            task.start(FIRST_DELAY_MS);
        },
        async stop() {
            detach?.();
            detach = null;
            await task?.stop();
            task = null;
            await db?.close();
            db = null;
        },
    };
}

/** Marks authors whose Discord names change. Returns the unsubscribe. */
function listen(
    client: DiscordClient,
    store: PostgresNameStore,
    logger: AddonLogger
): () => void {
    const mark = (userId: string, guildId?: string) => {
        store.markDirty(userId, guildId).catch((error: unknown) => {
            logger.warn(
                `[name-sync] Could not mark ${userId}: ${describe(error)}`
            );
        });
    };
    const onMember = (
        before: GuildMember | PartialGuildMember,
        after: GuildMember
    ) => {
        if (memberChanged(before, after)) mark(after.id, after.guild.id);
    };
    const onUser = (before: User | PartialUser, after: User) => {
        if (userChanged(before, after)) mark(after.id);
    };
    client.on(Events.GuildMemberUpdate, onMember);
    client.on(Events.UserUpdate, onUser);
    return () => {
        client.off(Events.GuildMemberUpdate, onMember);
        client.off(Events.UserUpdate, onUser);
    };
}

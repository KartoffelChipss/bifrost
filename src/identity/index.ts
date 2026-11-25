import { hostname } from 'node:os';
import {
    Events as FluxerEvents,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import {
    ChannelType,
    Events,
    type Client as DiscordClient,
    type GuildMember,
    type Message,
    type PartialGuildMember,
} from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import { RepeatingTask } from '../addons/loop';
import { resolveMode, type LinkedGuild } from '../guild-sync/cycle';
import { NoticeBoard, type SendNotice } from '../guild-sync/notices';
import { IDENTITY_LOCK_KEY, PostgresGuildSyncStore } from '../guild-sync/store';
import { followFluxerClient } from '../guild-sync/threadEvents';
import { HistoryEditor } from '../history/editor';
import { PostgresHistoryStore } from '../history/store';
import type { HistoryPorts } from '../history/types';
import type { ChannelLinker } from '../guild-sync/links';
import { handleDm, type DmInput, type FlowDeps } from './flow';
import { roleChanges, syncableRoles } from './roles';
import { PostgresIdentityStore, type AccountPair, type Side } from './store';

export const ADDON_NAME = 'identity';

/** Role removals per sweep. The rest wait, so an outage cannot strip everyone. */
export const MAX_ROLE_REMOVALS_PER_SWEEP = 25;
const SWEEP_MS = 10 * 60_000;
const MAX_LINKS = 50;

/** The platform calls account linking needs. */
export interface IdentityPorts {
    sendDm(side: Side, userId: string, text: string): Promise<void>;
    userName(side: Side, userId: string): Promise<string>;
    /** Role IDs, or null when the user is not a member of the server. */
    discordMemberRoles(
        guildId: string,
        userId: string
    ): Promise<string[] | null>;
    fluxerMemberRoles(
        guildId: string,
        userId: string
    ): Promise<string[] | null>;
    setFluxerMemberRoles(
        guildId: string,
        userId: string,
        roleIds: string[]
    ): Promise<void>;
}

export interface IdentityDeps {
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly sequelize: Sequelize;
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly ports: IdentityPorts;
    readonly historyEnabled: boolean;
    readonly links: ChannelLinker;
    readonly historyPorts: Pick<HistoryPorts, 'editCopy' | 'deleteCopy'>;
    readonly sendNotice: SendNotice;
}

interface Tally {
    add: number;
    remove: number;
    removalsLeft: number;
}

/** Keeps linked members' synced roles in step on one guild link. */
class RoleSync {
    private readonly sync: PostgresGuildSyncStore;

    constructor(
        private readonly deps: IdentityDeps,
        private readonly context: AddonContext
    ) {
        this.sync = new PostgresGuildSyncStore(deps.sequelize);
    }

    async mode(link: LinkedGuild) {
        const settings = await this.sync.loadSettings(link.id);
        if (settings.direction !== 'discord-to-fluxer')
            return 'read-only' as const;
        return resolveMode(
            this.context.mode.mode,
            settings,
            this.context.allowApply
        ).mode;
    }

    /** Syncs one member. In dry-run it only counts the changes. */
    async member(
        link: LinkedGuild,
        pair: AccountPair,
        tally: Tally
    ): Promise<void> {
        const mode = await this.mode(link);
        if (mode === 'read-only') return;
        const snapshot = await this.sync.lastSnapshot(link.id, 'discord', true);
        if (!snapshot) return;
        const syncable = syncableRoles(
            snapshot,
            await this.sync.loadObjectMap(link.id)
        );
        const { ports } = this.deps;
        const discord = await ports.discordMemberRoles(
            link.discordGuildId,
            pair.discordUserId
        );
        const fluxer = await ports.fluxerMemberRoles(
            link.fluxerGuildId,
            pair.fluxerUserId
        );
        if (!discord || !fluxer) return;
        const change = roleChanges(discord, fluxer, syncable);
        const removing = change.remove.slice(
            0,
            Math.max(0, tally.removalsLeft)
        );
        tally.add += change.add.length;
        tally.remove += removing.length;
        tally.removalsLeft -= removing.length;
        if (
            mode !== 'apply' ||
            (change.add.length === 0 && removing.length === 0)
        )
            return;
        const next = fluxer
            .filter((id) => !removing.includes(id))
            .concat(change.add);
        await ports.setFluxerMemberRoles(
            link.fluxerGuildId,
            pair.fluxerUserId,
            next
        );
    }

    async allLinks(pair: AccountPair): Promise<void> {
        const tally = {
            add: 0,
            remove: 0,
            removalsLeft: MAX_ROLE_REMOVALS_PER_SWEEP,
        };
        for (const link of (await this.deps.listGuildLinks()).slice(
            0,
            MAX_LINKS
        )) {
            await this.member(link, pair, tally);
        }
    }

    adminChannel(link: LinkedGuild) {
        return this.sync.loadSettings(link.id).then((s) => s.adminChannelId);
    }

    lock<T>(holder: string, fn: () => Promise<T>) {
        return this.sync.withLeaderLock(holder, fn, IDENTITY_LOCK_KEY);
    }
}

function flowDeps(
    deps: IdentityDeps,
    roles: RoleSync,
    store: PostgresIdentityStore
): FlowDeps {
    const historyStore = deps.historyEnabled
        ? new PostgresHistoryStore(deps.sequelize)
        : null;
    return {
        store,
        nameOf: (side, id) => deps.ports.userName(side, id),
        history: historyStore
            ? {
                  editor: new HistoryEditor(
                      historyStore,
                      deps.links,
                      deps.historyPorts
                  ),
                  setOptOut: (id, out, now) =>
                      historyStore.setOptOut(id, out, now),
              }
            : null,
        onLinked: (pair) => roles.allLinks(pair),
        now: () => new Date(),
    };
}

/** Answers a DM and sends the replies. */
async function answer(input: DmInput, flow: FlowDeps, ports: IdentityPorts) {
    for (const reply of await handleDm(input, flow)) {
        await ports.sendDm(reply.side, reply.userId, reply.text);
    }
}

type Wrap = <A extends unknown[]>(
    task: string,
    fn: (...args: A) => Promise<void> | void
) => (...args: A) => void;

interface Listeners {
    readonly deps: IdentityDeps;
    readonly flow: FlowDeps;
    readonly roles: RoleSync;
    readonly store: PostgresIdentityStore;
    readonly wrap: Wrap;
}

/** Syncs one linked member on every guild link that matches `onLink`. */
async function syncPair(
    l: Listeners,
    pair: AccountPair,
    onLink: (link: LinkedGuild) => boolean
): Promise<void> {
    const links = (await l.deps.listGuildLinks()).filter(onLink);
    const tally = {
        add: 0,
        remove: 0,
        removalsLeft: MAX_ROLE_REMOVALS_PER_SWEEP,
    };
    for (const link of links) await l.roles.member(link, pair, tally);
}

/** DMs and role changes on Discord. Returns a function that stops it. */
function listenToDiscord(l: Listeners): () => void {
    const client = l.deps.discordClient;
    const onDm = l.wrap('dm', async (message: Message) => {
        if (message.author.bot || message.channel.type !== ChannelType.DM)
            return;
        const input = {
            side: 'discord' as const,
            userId: message.author.id,
            text: message.content,
        };
        await answer(input, l.flow, l.deps.ports);
    });
    const onMember = l.wrap(
        'member',
        async (_old: GuildMember | PartialGuildMember, member: GuildMember) => {
            const pair = await l.store.pairFor('discord', member.id);
            if (pair)
                await syncPair(
                    l,
                    pair,
                    (link) => link.discordGuildId === member.guild.id
                );
        }
    );
    client.on(Events.MessageCreate, onDm);
    client.on(Events.GuildMemberUpdate, onMember);
    return () => {
        client.off(Events.MessageCreate, onDm);
        client.off(Events.GuildMemberUpdate, onMember);
    };
}

interface FluxerDm {
    readonly guildId?: string | null;
    readonly content?: string;
    readonly author?: { readonly id: string; readonly bot?: boolean } | null;
}

interface FluxerJoin {
    readonly id?: string;
    readonly user?: { readonly id: string };
    readonly guild?: { readonly id: string };
}

/** DMs and joins on one Fluxer client. Returns a function that stops it. */
function listenToFluxer(l: Listeners, client: FluxerClient): () => void {
    const onDm = l.wrap('dm', async (message: FluxerDm) => {
        if (message.guildId || !message.author || message.author.bot) return;
        const input = {
            side: 'fluxer' as const,
            userId: message.author.id,
            text: message.content ?? '',
        };
        await answer(input, l.flow, l.deps.ports);
    });
    const onJoin = l.wrap('join', async (member: FluxerJoin) => {
        const userId = member.user?.id ?? member.id;
        const pair = userId ? await l.store.pairFor('fluxer', userId) : null;
        if (pair)
            await syncPair(
                l,
                pair,
                (link) => link.fluxerGuildId === member.guild?.id
            );
    });
    client.on(FluxerEvents.MessageCreate, onDm);
    client.on(FluxerEvents.GuildMemberAdd, onJoin);
    return () => {
        client.off(FluxerEvents.MessageCreate, onDm);
        client.off(FluxerEvents.GuildMemberAdd, onJoin);
    };
}

function listen(l: Listeners): () => void {
    const stopDiscord = listenToDiscord(l);
    const stopFluxer = followFluxerClient(l.deps.fluxerClientRef, (client) =>
        listenToFluxer(l, client)
    );
    return () => {
        stopDiscord();
        stopFluxer();
    };
}

/** One sweep over every linked member and guild link. */
async function sweep(
    deps: IdentityDeps,
    roles: RoleSync,
    store: PostgresIdentityStore,
    notices: NoticeBoard
) {
    const pairs = await store.listPairs();
    for (const link of (await deps.listGuildLinks()).slice(0, MAX_LINKS)) {
        const tally = {
            add: 0,
            remove: 0,
            removalsLeft: MAX_ROLE_REMOVALS_PER_SWEEP,
        };
        for (const pair of pairs) await roles.member(link, pair, tally);
        const mode = await roles.mode(link);
        if (mode !== 'dry-run' || pairs.length === 0) continue;
        const text = `Account linking (dry-run): ${pairs.length} linked members. Would add ${tally.add} roles and remove ${tally.remove}.`;
        await notices.post(
            `identity:${link.id}`,
            await roles.adminChannel(link),
            text,
            text
        );
    }
}

/**
 * The identity add-on: account linking by DM, roles that follow linked
 * members, and edits or deletes of a member's imported messages.
 */
export function createIdentityAddon(deps: IdentityDeps): Addon {
    let stopListening: (() => void) | null = null;
    let task: RepeatingTask | null = null;
    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const store = new PostgresIdentityStore(deps.sequelize);
            const roles = new RoleSync(deps, context);
            const notices = new NoticeBoard(deps.sendNotice, context.logger);
            stopListening = listen({
                deps,
                flow: flowDeps(deps, roles, store),
                roles,
                store,
                wrap: (task, fn) =>
                    context.boundary.handler(ADDON_NAME, task, fn),
            });
            const holder = `${hostname()}:${process.pid}:identity`;
            task = new RepeatingTask(
                async () => {
                    await context.boundary.run(ADDON_NAME, 'sweep', () =>
                        roles.lock(holder, () =>
                            sweep(deps, roles, store, notices)
                        )
                    );
                    return false;
                },
                SWEEP_MS,
                SWEEP_MS
            );
            task.start(SWEEP_MS);
        },
        async stop() {
            stopListening?.();
            stopListening = null;
            await task?.stop();
            task = null;
        },
    };
}

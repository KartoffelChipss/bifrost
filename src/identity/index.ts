import { hostname } from 'node:os';
import {
    Events as FluxerEvents,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import {
    ChannelType,
    Events,
    type Client as DiscordClient,
    type GuildBan,
    type GuildMember,
    type Message,
    type PartialGuildMember,
} from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import type { AddonLogger } from '../addons/isolation';
import { RepeatingTask } from '../addons/loop';
import type { LinkedGuild } from '../guild-sync/cycle';
import { NoticeBoard, type SendNotice } from '../guild-sync/notices';
import { IDENTITY_LOCK_KEY, PostgresGuildSyncStore } from '../guild-sync/store';
import { followFluxerClient } from '../guild-sync/threadEvents';
import { HistoryEditor, type EditorThreads } from '../history/editor';
import { PostgresHistoryStore } from '../history/store';
import type { HistoryPorts } from '../history/types';
import type { ChannelLinker } from '../guild-sync/links';
import {
    describeUser,
    handleDm,
    type DmInput,
    type DmReply,
    type FlowDeps,
} from './flow';
import { DmGate } from './gate';
import type { IdentityPorts } from './ports';
import {
    MAX_LINKS,
    MAX_ROLE_REMOVALS_PER_HOUR,
    RoleSync,
    SWEEP_BUDGET_MS,
    rotate,
    type Tally,
} from './roleSync';
import { PostgresIdentityStore, type AccountPair } from './store';

export type { IdentityPorts, MemberState, UserInfo } from './ports';

export const ADDON_NAME = 'identity';

const SWEEP_MS = 10 * 60_000;
/** Failed link attempts are kept this long; the lock looks back one hour. */
const FAILURE_RETENTION_MS = 24 * 60 * 60_000;

export interface IdentityDeps {
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly sequelize: Sequelize;
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly ports: IdentityPorts;
    readonly historyEnabled: boolean;
    readonly links: ChannelLinker;
    readonly historyPorts: Pick<HistoryPorts, 'editCopy' | 'deleteCopy'>;
    /** Opens a closed Fluxer thread for a member's edit of a copy in it. */
    readonly editorThreads?: EditorThreads;
    readonly sendNotice: SendNotice;
    /** Upstream's command prefix. Identity ignores DMs that start with it. */
    readonly commandPrefix: string;
}

function flowDeps(
    deps: IdentityDeps,
    roles: RoleSync,
    store: PostgresIdentityStore,
    logger: AddonLogger
): FlowDeps {
    const historyStore = deps.historyEnabled
        ? new PostgresHistoryStore(deps.sequelize)
        : null;
    return {
        store,
        nameOf: async (side, id) =>
            describeUser(await deps.ports.userInfo(side, id)),
        history: historyStore
            ? {
                  editor: new HistoryEditor(
                      historyStore,
                      deps.links,
                      deps.historyPorts,
                      deps.editorThreads
                  ),
                  setOptOut: (id, out, now) =>
                      historyStore.setOptOut(id, out, now),
              }
            : null,
        onLinked: (pair) => roles.pair(pair),
        onUnlinked: (pair) => roles.strip(pair),
        now: () => new Date(),
        logger,
    };
}

export const FAILED_REPLY = 'Something went wrong. Try again later.';

/** The replies to a DM. A failure is logged and answered with an apology. */
async function repliesTo(
    input: DmInput,
    flow: FlowDeps,
    logger: AddonLogger
): Promise<DmReply[]> {
    try {
        return await handleDm(input, flow);
    } catch (error) {
        logger.warn(
            `[identity] Could not handle a DM from ${input.side} user ${input.userId}:`,
            error
        );
        return [{ side: input.side, userId: input.userId, text: FAILED_REPLY }];
    }
}

/**
 * Answers a DM and sends the replies. A failure while handling it, or a
 * reply that cannot be sent, such as to a member with DMs closed, is
 * logged: it is expected, and must not switch the add-ons to read-only.
 */
export async function answer(
    input: DmInput,
    flow: FlowDeps,
    ports: Pick<IdentityPorts, 'sendDm'>,
    logger: AddonLogger
): Promise<void> {
    for (const reply of await repliesTo(input, flow, logger)) {
        try {
            await ports.sendDm(reply.side, reply.userId, reply.text);
        } catch (error) {
            logger.warn(
                `[identity] Could not DM ${reply.side} user ${reply.userId}:`,
                error
            );
        }
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
    readonly gate: DmGate;
    readonly logger: AddonLogger;
    readonly wrap: Wrap;
}

/**
 * Runs a member event's work, logging a failure such as a database error.
 * An event that reached the add-on boundary would switch every add-on to
 * read-only.
 */
export async function quietly(
    logger: AddonLogger,
    what: string,
    work: () => Promise<void>
): Promise<void> {
    try {
        await work();
    } catch (error) {
        logger.warn(`[identity] ${what}:`, error);
    }
}

/** Answers one DM unless the gate drops it. */
async function onDirectMessage(l: Listeners, input: DmInput): Promise<void> {
    if (!l.gate.admit(input.side, input.userId, input.text, Date.now())) return;
    await answer(input, l.flow, l.deps.ports, l.logger);
}

/** DMs and role changes on Discord. Returns a function that stops it. */
function listenToDiscord(l: Listeners): () => void {
    const client = l.deps.discordClient;
    const onDm = l.wrap('dm', async (message: Message) => {
        if (message.author.bot || message.channel.type !== ChannelType.DM)
            return;
        await onDirectMessage(l, {
            side: 'discord',
            userId: message.author.id,
            text: message.content,
        });
    });
    const onMember = l.wrap(
        'member',
        (_old: GuildMember | PartialGuildMember, member: GuildMember) =>
            syncDiscordMember(l, member.id, member.guild.id)
    );
    // A member who left holds no roles, so their synced roles go too.
    const onLeave = l.wrap(
        'member-leave',
        (member: GuildMember | PartialGuildMember) =>
            syncDiscordMember(l, member.id, member.guild.id)
    );
    const stopBans = listenToDiscordBans(l);
    client.on(Events.MessageCreate, onDm);
    client.on(Events.GuildMemberUpdate, onMember);
    client.on(Events.GuildMemberRemove, onLeave);
    return () => {
        stopBans();
        client.off(Events.MessageCreate, onDm);
        client.off(Events.GuildMemberUpdate, onMember);
        client.off(Events.GuildMemberRemove, onLeave);
    };
}

/**
 * Discord bans and unbans of linked members (Guild Moderation intent). A
 * ban is applied by the member sync, which finds it; an unban lifts only
 * a Fluxer ban the sync made.
 */
function listenToDiscordBans(l: Listeners): () => void {
    const client = l.deps.discordClient;
    const onBan = l.wrap('ban', (ban: GuildBan) =>
        syncDiscordMember(l, ban.user.id, ban.guild.id)
    );
    const onUnban = l.wrap('unban', (ban: GuildBan) =>
        quietly(l.logger, `Unban of ${ban.user.id}`, async () => {
            const pair = await l.store.pairFor('discord', ban.user.id);
            if (pair) await l.roles.unban(pair, ban.guild.id);
        })
    );
    client.on(Events.GuildBanAdd, onBan);
    client.on(Events.GuildBanRemove, onUnban);
    return () => {
        client.off(Events.GuildBanAdd, onBan);
        client.off(Events.GuildBanRemove, onUnban);
    };
}

/** Syncs a linked Discord member on the links of one Discord server. */
function syncDiscordMember(
    l: Listeners,
    userId: string,
    guildId: string
): Promise<void> {
    return quietly(l.logger, `Member change of ${userId}`, async () => {
        const pair = await l.store.pairFor('discord', userId);
        if (pair)
            await l.roles.pair(pair, (link) => link.discordGuildId === guildId);
    });
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
        await onDirectMessage(l, {
            side: 'fluxer',
            userId: message.author.id,
            text: message.content ?? '',
        });
    });
    const onJoin = l.wrap('join', (member: FluxerJoin) =>
        quietly(l.logger, 'Fluxer member join', async () => {
            const userId = member.user?.id ?? member.id;
            const pair = userId
                ? await l.store.pairFor('fluxer', userId)
                : null;
            if (pair)
                await l.roles.pair(
                    pair,
                    (link) => link.fluxerGuildId === member.guild?.id
                );
        })
    );
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

/** The admin notice for one link in dry-run. */
export function dryRunNotice(
    pairs: number,
    tally: Tally,
    checked = pairs
): string {
    const partial =
        checked < pairs
            ? ` (${checked} checked this sweep; the rest next)`
            : '';
    return `Account linking (dry-run): ${pairs} linked members${partial}. Would add ${tally.add} roles, remove ${tally.remove} roles, set ${tally.nicks} nicknames, ban ${tally.bans} and set ${tally.timeouts} timeouts. At most ${MAX_ROLE_REMOVALS_PER_HOUR} role removals per hour are applied.`;
}

/** Where each guild link's next sweep resumes, by pair index. */
type Cursors = Map<string, number>;

interface SweepParts {
    readonly roles: RoleSync;
    readonly store: PostgresIdentityStore;
    readonly notices: NoticeBoard;
    readonly logger: AddonLogger;
}

/**
 * Housekeeping, then one pass over the guild links and their linked
 * members, bounded by SWEEP_BUDGET_MS; each link resumes where its last
 * sweep stopped. One link's failure is logged and skips only that link.
 */
async function sweep(deps: IdentityDeps, s: SweepParts, cursors: Cursors) {
    const now = new Date();
    const deadline = now.getTime() + SWEEP_BUDGET_MS;
    await s.store.purgeExpired(
        now,
        new Date(now.getTime() - FAILURE_RETENTION_MS)
    );
    const pairs = await s.store.listPairs();
    for (const link of (await deps.listGuildLinks()).slice(0, MAX_LINKS)) {
        if (Date.now() >= deadline) break;
        await quietly(s.logger, `Sweep of guild link ${link.id}`, () =>
            sweepOne(link, pairs, deadline, s, cursors)
        );
    }
}

async function sweepOne(
    link: LinkedGuild,
    pairs: readonly AccountPair[],
    deadline: number,
    s: SweepParts,
    cursors: Cursors
): Promise<void> {
    const start = cursors.get(link.id) ?? 0;
    const result = await s.roles.sweepLink(
        link,
        rotate(pairs, start),
        deadline
    );
    if (!result) return;
    cursors.set(link.id, (start + result.checked) % Math.max(pairs.length, 1));
    if (result.plan.mode !== 'dry-run' || pairs.length === 0) return;
    const text = dryRunNotice(pairs.length, result.tally, result.checked);
    await s.notices.post(
        `identity:${link.id}`,
        result.plan.adminChannelId,
        text,
        text
    );
}

function createRoleSync(deps: IdentityDeps, context: AddonContext) {
    return new RoleSync({
        store: new PostgresGuildSyncStore(deps.sequelize),
        ports: deps.ports,
        listGuildLinks: deps.listGuildLinks,
        processMode: () => context.mode.mode,
        allowApply: context.allowApply,
        logger: context.logger,
        now: () => Date.now(),
    });
}

/** The 10-minute sweep, under the identity leader lock. */
function sweepTask(
    deps: IdentityDeps,
    context: AddonContext,
    roles: RoleSync,
    store: PostgresIdentityStore
): RepeatingTask {
    const lock = new PostgresGuildSyncStore(deps.sequelize);
    const parts: SweepParts = {
        roles,
        store,
        notices: new NoticeBoard(deps.sendNotice, context.logger),
        logger: context.logger,
    };
    const cursors: Cursors = new Map();
    const holder = `${hostname()}:${process.pid}:identity`;
    return new RepeatingTask(
        async () => {
            await context.boundary.run(ADDON_NAME, 'sweep', () =>
                lock.withLeaderLock(
                    holder,
                    () => sweep(deps, parts, cursors),
                    IDENTITY_LOCK_KEY
                )
            );
            return false;
        },
        SWEEP_MS,
        SWEEP_MS
    );
}

/**
 * The identity add-on: account linking by DM, roles and nicknames that
 * follow linked members, and edits or deletes of a member's imported
 * messages.
 */
export function createIdentityAddon(deps: IdentityDeps): Addon {
    let stopListening: (() => void) | null = null;
    let task: RepeatingTask | null = null;
    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const store = new PostgresIdentityStore(deps.sequelize);
            const roles = createRoleSync(deps, context);
            stopListening = listen({
                deps,
                flow: flowDeps(deps, roles, store, context.logger),
                roles,
                store,
                gate: new DmGate(deps.commandPrefix),
                logger: context.logger,
                wrap: (task, fn) =>
                    context.boundary.handler(ADDON_NAME, task, fn),
            });
            task = sweepTask(deps, context, roles, store);
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

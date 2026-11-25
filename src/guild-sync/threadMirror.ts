import { UnrecordedWriteError, type AddonLogger } from '../addons/isolation';
import { CLOCK_SKEW_MS, snowflakeTime } from './adopt';
import type { LinkedChannel } from './links';
import { projectDestThread, type Fields } from './project';
import type { ThreadSnap } from './snapshot';
import type { NewMapping, ThreadRelayStore } from './store';
import type { ThreadMessageEvent } from './threadRelay';

/**
 * Copies a thread or forum post started on Fluxer to Discord, so the thread
 * relay has a pair to relay its replies to, both ways. Structure syncs from
 * Discord, so the new Discord thread becomes the source of that pair: later
 * renames on Discord follow to Fluxer, and edits on Fluxer count as drift.
 *
 * The copy takes the Fluxer thread's settings where Discord allows them,
 * and the map row records the copy's own settings as written. The next
 * cycle then finds nothing to change on the Fluxer thread; a setting the
 * copy could not take shows as drift, which is reported and never written.
 *
 * A private Fluxer thread becomes a private Discord thread with the linked
 * Discord accounts of its members, or is not copied at all.
 */

/** A Fluxer thread, as the mirror needs it: its snapshot and more. */
export interface FluxerThreadInfo extends ThreadSnap {
    /** The user who started it, or null when Fluxer did not say. */
    readonly ownerId: string | null;
    /** True for a post in a forum, which starts with its first message. */
    readonly forum: boolean;
}

/** A thread's synced settings, as the readers snapshot them. */
export type ThreadLook = Omit<ThreadSnap, 'id' | 'parentId'>;

/** A Discord thread, as the mirror needs it. */
export interface DiscordThreadInfo {
    readonly id: string;
    /** Who started it: a user, or the webhook that posted a forum post. */
    readonly ownerId: string | null;
    /** As the Discord reader snapshots it (readers/discord.ts). */
    readonly look: ThreadLook;
}

export interface ThreadMirrorPorts {
    fluxerThread(threadId: string): Promise<FluxerThreadInfo | null>;
    /** The Fluxer bot's user ID, or null before login. */
    fluxerBotId(): string | null;
    /** The Discord bot's user ID, or null before login. */
    discordBotId(): string | null;
    /** The active threads of the link's Discord channel. */
    activeDiscordThreads(link: LinkedChannel): Promise<DiscordThreadInfo[]>;
    /**
     * Starts a Discord forum post through the forum's webhook, with the
     * Fluxer post's first message (`starter`, or fetched when null). The
     * post's ID is also its first message's ID.
     */
    createDiscordPost(
        link: LinkedChannel,
        info: FluxerThreadInfo,
        starter: unknown | null
    ): Promise<DiscordThreadInfo>;
    /**
     * Starts a thread in a Discord text channel, private when `info` is.
     * Null when a private thread cannot be started there: the channel is
     * not a text channel, or the bot may not create private threads.
     */
    createDiscordThread(
        link: LinkedChannel,
        info: FluxerThreadInfo
    ): Promise<DiscordThreadInfo | null>;
    /** The user IDs of a Fluxer thread's members. */
    fluxerThreadMembers(threadId: string): Promise<string[]>;
    /** Adds users to a private Discord thread. */
    addDiscordThreadMembers(
        threadId: string,
        userIds: readonly string[]
    ): Promise<void>;
}

export interface ThreadMirrorDeps {
    readonly store: Pick<ThreadRelayStore, 'findThreadPair'> &
        Pick<ThreadRelayStore, 'saveThreadMessage'> & {
            insertMapping(mapping: NewMapping, now: Date): Promise<unknown>;
        };
    readonly ports: ThreadMirrorPorts;
    /** True when the guild link may write: apply mode, Discord as source. */
    readonly mayWrite: (guildLinkId: string) => Promise<boolean>;
    /**
     * Linked accounts, Discord user ID to Fluxer user ID. Without it, a
     * private thread's copy has no members besides the bot.
     */
    readonly linkedAccounts?: () => Promise<ReadonlyMap<string, string>>;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

export interface ThreadPair {
    readonly guildLinkId: string;
    readonly discordId: string;
    readonly fluxerId: string;
}

export interface Mirrored {
    readonly pair: ThreadPair;
    /** True when the triggering message was posted as the post's start. */
    readonly starterCopied: boolean;
}

/**
 * A pair; null when the thread must wait; 'skip' when it is never copied,
 * so its replies are not held.
 */
export type MirrorResult = Mirrored | 'skip' | null;

/** Upper bound on Discord threads checked for an earlier copy. */
export const MAX_COPY_CANDIDATES = 50;

/** The fields the sync compares on the Fluxer thread (projectDestThread). */
function threadFields(look: ThreadLook, info: FluxerThreadInfo): Fields {
    return projectDestThread({ ...look, id: info.id, parentId: info.parentId });
}

/** Fields where the Discord copy differs from the Fluxer thread. */
function differing(look: ThreadLook, info: FluxerThreadInfo): string[] {
    const copy = threadFields(look, info);
    const original = projectDestThread(info);
    const fields = new Set([...Object.keys(copy), ...Object.keys(original)]);
    return [...fields].filter(
        (field) =>
            JSON.stringify(copy[field]) !== JSON.stringify(original[field])
    );
}

const isPrivate = (look: ThreadLook) => look.private === true;

export class ThreadMirror {
    /** One mirror at a time per thread, so a burst of replies makes one copy. */
    private readonly inFlight = new Map<string, Promise<MirrorResult>>();

    constructor(private readonly deps: ThreadMirrorDeps) {}

    /**
     * The pair for an unmapped Fluxer thread, after creating its Discord
     * copy. Null when it must wait: not in apply mode, or the thread may be
     * one the sync itself is creating.
     */
    mirror(
        link: LinkedChannel,
        event: ThreadMessageEvent,
        raw: unknown
    ): Promise<MirrorResult> {
        const running = this.inFlight.get(event.channelId);
        if (running)
            return running.then((done) =>
                done && done !== 'skip'
                    ? { ...done, starterCopied: false }
                    : done
            );
        const work = this.run(link, event, raw).finally(() =>
            this.inFlight.delete(event.channelId)
        );
        this.inFlight.set(event.channelId, work);
        return work;
    }

    /**
     * True for a thread the sync or its webhook may have started. Its map
     * row lands right after the create returns, so such a thread waits.
     * Fluxer names the webhook as the owner of a post it started.
     */
    private mayBeOwn(info: FluxerThreadInfo, link: LinkedChannel): boolean {
        const bot = this.deps.ports.fluxerBotId();
        return (
            info.ownerId === null ||
            info.ownerId === bot ||
            info.ownerId === link.fluxerWebhook.id
        );
    }

    private async run(
        link: LinkedChannel,
        event: ThreadMessageEvent,
        raw: unknown
    ): Promise<MirrorResult> {
        const known = await this.deps.store.findThreadPair(
            'fluxer',
            event.channelId
        );
        if (known) return { pair: known, starterCopied: false };
        if (!(await this.deps.mayWrite(link.guildLinkId))) return null;
        const info = await this.deps.ports.fluxerThread(event.channelId);
        if (!info || this.mayBeOwn(info, link)) return null;
        // Discord has no private forum posts.
        if (info.private === true && info.forum) return this.refuse(info);
        const isStarter = event.id === info.id;
        const copy =
            (await this.earlierCopy(link, info)) ??
            (await this.create(link, info, isStarter ? raw : null));
        if (!copy) return this.refuse(info);
        const pair = {
            guildLinkId: link.guildLinkId,
            discordId: copy.id,
            fluxerId: info.id,
        };
        await this.recordPair(pair, info, copy.look);
        if (info.forum) await this.recordStarter(pair);
        if (isPrivate(copy.look)) await this.addMembers(pair);
        this.report(info, copy);
        return { pair, starterCopied: info.forum && isStarter };
    }

    private create(
        link: LinkedChannel,
        info: FluxerThreadInfo,
        starter: unknown | null
    ): Promise<DiscordThreadInfo | null> {
        const { ports } = this.deps;
        return info.forum
            ? ports.createDiscordPost(link, info, starter)
            : ports.createDiscordThread(link, info);
    }

    /** Never copies a private thread as a public one: it is not copied. */
    private refuse(info: FluxerThreadInfo): 'skip' {
        this.deps.logger.warn(
            `[guild-sync] Fluxer thread ${info.id} is private and the bot cannot start a private Discord thread for it (a text channel and Create Private Threads are needed); it is not copied and its replies are not relayed`
        );
        return 'skip';
    }

    /**
     * A copy an earlier attempt made but did not record, such as when the
     * process stopped between the create and the map row. It is unmapped,
     * has the thread's name, was started by the bot or the link's webhook,
     * and is newer than the Fluxer thread, which no other copy can be.
     */
    private async earlierCopy(
        link: LinkedChannel,
        info: FluxerThreadInfo
    ): Promise<DiscordThreadInfo | null> {
        const since = snowflakeTime(info.id);
        if (since === null) return null;
        const owners = [this.deps.ports.discordBotId(), link.discordWebhook.id];
        const candidates = (await this.deps.ports.activeDiscordThreads(link))
            .filter(
                (t) =>
                    t.look.name === info.name &&
                    t.ownerId !== null &&
                    owners.includes(t.ownerId) &&
                    isPrivate(t.look) === (info.private === true) &&
                    (snowflakeTime(t.id) ?? 0) >= since - CLOCK_SKEW_MS
            )
            .slice(0, MAX_COPY_CANDIDATES);
        for (const candidate of candidates) {
            const owned = await this.deps.store.findThreadPair(
                'discord',
                candidate.id
            );
            if (!owned) return candidate;
        }
        return null;
    }

    /**
     * Records the new Discord thread. If that fails, the thread exists but
     * nothing owns it, so every add-on must stop (guard 15). The applied
     * fields are the copy's own, so the next cycle writes nothing.
     */
    private async recordPair(
        pair: ThreadPair,
        info: FluxerThreadInfo,
        look: ThreadLook
    ) {
        try {
            await this.deps.store.insertMapping(
                {
                    ...pair,
                    kind: 'thread',
                    // The Fluxer thread was not made by the sync.
                    createdBySync: false,
                    appliedFields: threadFields(look, info),
                },
                this.deps.now()
            );
        } catch (cause) {
            throw new UnrecordedWriteError(
                `Discord thread ${pair.discordId} was created for Fluxer thread ${pair.fluxerId} but not recorded`,
                { cause }
            );
        }
    }

    /** A post's first message shares the post's ID on both platforms. */
    private recordStarter(pair: ThreadPair) {
        return this.deps.store.saveThreadMessage(
            {
                guildLinkId: pair.guildLinkId,
                discordThreadId: pair.discordId,
                fluxerThreadId: pair.fluxerId,
                discordMessageId: pair.discordId,
                fluxerMessageId: pair.fluxerId,
            },
            this.deps.now()
        );
    }

    /** The Discord accounts linked to the Fluxer thread's members. */
    private async linkedDiscordMembers(fluxerThreadId: string) {
        const accounts = await this.deps.linkedAccounts?.();
        if (!accounts || accounts.size === 0) return [];
        const members = new Set(
            await this.deps.ports.fluxerThreadMembers(fluxerThreadId)
        );
        const out: string[] = [];
        for (const [discordId, fluxerId] of accounts) {
            if (members.has(fluxerId)) out.push(discordId);
        }
        return out;
    }

    /**
     * Adds the linked members to a private copy. The pair is recorded
     * already, so a failure is logged; members can still be added by hand.
     */
    private async addMembers(pair: ThreadPair): Promise<void> {
        try {
            const members = await this.linkedDiscordMembers(pair.fluxerId);
            if (members.length === 0) return;
            await this.deps.ports.addDiscordThreadMembers(
                pair.discordId,
                members
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : error;
            this.deps.logger.warn(
                `[guild-sync] Could not add members to private Discord thread ${pair.discordId}: ${detail}`
            );
        }
    }

    private report(info: FluxerThreadInfo, copy: DiscordThreadInfo) {
        const { logger } = this.deps;
        logger.info(
            `[guild-sync] Copied Fluxer thread ${info.id} to Discord as ${copy.id}`
        );
        const fields = differing(copy.look, info);
        if (fields.length === 0) return;
        logger.warn(
            `[guild-sync] Discord thread ${copy.id} could not take these settings of Fluxer thread ${info.id}, which show as drift: ${fields.join(', ')}`
        );
    }
}

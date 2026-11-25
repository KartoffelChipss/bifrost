import type { AddonLogger } from '../addons/isolation';
import type { LinkedChannel } from './links';
import type { NewMapping, ThreadRelayStore } from './store';
import type { ThreadMessageEvent } from './threadRelay';

/**
 * Copies a thread or forum post started on Fluxer to Discord, so the thread
 * relay has a pair to relay its replies to, both ways. Structure syncs from
 * Discord, so the new Discord thread becomes the source of that pair: later
 * renames on Discord follow to Fluxer, and edits on Fluxer count as drift.
 */

/** A Fluxer thread, as the mirror needs it. */
export interface FluxerThreadInfo {
    readonly id: string;
    readonly parentId: string;
    readonly name: string;
    /** The user who started it, or null when Fluxer did not say. */
    readonly ownerId: string | null;
    /** True for a post in a forum, which starts with its first message. */
    readonly forum: boolean;
    /** Names of the applied forum tags, sorted. */
    readonly tags: readonly string[];
    readonly archived: boolean;
    readonly locked: boolean;
}

export interface ThreadMirrorPorts {
    fluxerThread(threadId: string): Promise<FluxerThreadInfo | null>;
    /** The Fluxer bot's user ID, or null before login. */
    fluxerBotId(): string | null;
    /**
     * Starts a Discord forum post through the forum's webhook, with the
     * Fluxer post's first message (`starter`, or fetched when null).
     * Returns the post's ID, which is also its first message's ID.
     */
    createDiscordPost(
        link: LinkedChannel,
        info: FluxerThreadInfo,
        starter: unknown | null
    ): Promise<string>;
    /** Starts a thread in a Discord text channel. Returns its ID. */
    createDiscordThread(
        link: LinkedChannel,
        info: FluxerThreadInfo
    ): Promise<string>;
}

export interface ThreadMirrorDeps {
    readonly store: Pick<ThreadRelayStore, 'findThreadPair'> &
        Pick<ThreadRelayStore, 'saveThreadMessage'> & {
            insertMapping(mapping: NewMapping, now: Date): Promise<unknown>;
        };
    readonly ports: ThreadMirrorPorts;
    /** True when the guild link may write: apply mode, Discord as source. */
    readonly mayWrite: (guildLinkId: string) => Promise<boolean>;
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

/** Fields the sync recorded for the Fluxer copy, as projectDestThread has them. */
function appliedFields(info: FluxerThreadInfo) {
    return {
        name: info.name,
        archived: info.archived,
        locked: info.locked,
        tags: [...info.tags],
        parentId: info.parentId,
    };
}

export class ThreadMirror {
    /** One mirror at a time per thread, so a burst of replies makes one copy. */
    private readonly inFlight = new Map<string, Promise<Mirrored | null>>();

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
    ): Promise<Mirrored | null> {
        const running = this.inFlight.get(event.channelId);
        if (running)
            return running.then(
                (done) => done && { ...done, starterCopied: false }
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
    ): Promise<Mirrored | null> {
        const { store, ports, now } = this.deps;
        const known = await store.findThreadPair('fluxer', event.channelId);
        if (known) return { pair: known, starterCopied: false };
        if (!(await this.deps.mayWrite(link.guildLinkId))) return null;
        const info = await ports.fluxerThread(event.channelId);
        if (!info || this.mayBeOwn(info, link)) return null;
        const isStarter = event.id === info.id;
        const discordId = info.forum
            ? await ports.createDiscordPost(link, info, isStarter ? raw : null)
            : await ports.createDiscordThread(link, info);
        const pair = {
            guildLinkId: link.guildLinkId,
            discordId,
            fluxerId: info.id,
        };
        await store.insertMapping(
            {
                ...pair,
                kind: 'thread',
                // The Fluxer thread was not made by the sync.
                createdBySync: false,
                appliedFields: appliedFields(info),
            },
            now()
        );
        if (info.forum) await this.recordStarter(pair);
        this.deps.logger.info(
            `[guild-sync] Copied Fluxer thread ${info.id} to Discord as ${discordId}`
        );
        return { pair, starterCopied: info.forum && isStarter };
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
}

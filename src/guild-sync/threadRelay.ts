import type { SnapshotSide } from '../addons/db/schema';
import type { AddonLogger } from '../addons/isolation';
import type { ChannelLinker, LinkedChannel } from './links';
import type { ThreadRelayStore } from './store';

/**
 * Relays messages posted inside synced threads and forum posts. Upstream's
 * relay handles only messages posted directly in a bridged text channel,
 * so this covers the rest: create, edit and delete, in both directions.
 *
 * It is pure routing. The platform work is behind {@link ThreadRelayPorts}.
 */

/** What the relay needs to know about a message, on either platform. */
export interface ThreadMessageEvent {
    readonly id: string;
    /** The channel the message is in. For a relayed message, a thread. */
    readonly channelId: string;
    /** The thread's parent channel, or null when this is not a thread. */
    readonly parentId: string | null;
    /** Set when a webhook posted the message. */
    readonly webhookId: string | null;
}

/** The platform side of the relay. `raw` is the platform's own message. */
export interface ThreadRelayPorts {
    /** Posts a copy in the thread on side `to`. Returns the new message ID. */
    send(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        raw: unknown
    ): Promise<string>;
    edit(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        messageId: string,
        raw: unknown
    ): Promise<void>;
    remove(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        messageId: string
    ): Promise<void>;
}

export interface ThreadRelayDeps {
    readonly store: ThreadRelayStore;
    readonly links: ChannelLinker;
    readonly ports: ThreadRelayPorts;
    /** False while add-ons are read-only (guards 10 and 15). */
    readonly active: () => boolean;
    readonly now: () => Date;
    readonly logger: AddonLogger;
}

/** Messages held for a thread that is not created on the other side yet. */
export const MAX_PARKED_MESSAGES = 500;
export const PARKED_TTL_MS = 30 * 60_000;

interface Parked {
    readonly from: SnapshotSide;
    readonly event: ThreadMessageEvent;
    readonly raw: unknown;
    readonly at: number;
}

const other = (side: SnapshotSide): SnapshotSide =>
    side === 'discord' ? 'fluxer' : 'discord';

export class ThreadRelay {
    private parked: Parked[] = [];

    constructor(private readonly deps: ThreadRelayDeps) {}

    private linkFor(from: SnapshotSide, parentId: string) {
        return from === 'discord'
            ? this.deps.links.byDiscordChannel(parentId)
            : this.deps.links.byFluxerChannel(parentId);
    }

    /** True for a message the relay itself posted through its webhook. */
    private isOwn(
        from: SnapshotSide,
        event: ThreadMessageEvent,
        link: LinkedChannel
    ) {
        const own =
            from === 'discord' ? link.discordWebhook.id : link.fluxerWebhook.id;
        return event.webhookId !== null && event.webhookId === own;
    }

    /** Runs relay work so a failure is logged and never escapes. */
    private async guarded(what: string, work: () => Promise<void>) {
        try {
            await work();
        } catch (error) {
            const detail = error instanceof Error ? error.message : error;
            this.deps.logger.warn(
                `[guild-sync] Thread relay ${what}: ${detail}`
            );
        }
    }

    /** A new message in a thread. Returns true when a copy was posted. */
    private async relay(
        from: SnapshotSide,
        event: ThreadMessageEvent,
        raw: unknown
    ): Promise<'relayed' | 'unmapped' | 'ignored'> {
        const { store, ports, now } = this.deps;
        if (!event.parentId) return 'ignored';
        const link = await this.linkFor(from, event.parentId);
        if (!link || this.isOwn(from, event, link)) return 'ignored';
        const pair = await store.findThreadPair(from, event.channelId);
        if (!pair) return 'unmapped';
        const to = other(from);
        const threadId = to === 'fluxer' ? pair.fluxerId : pair.discordId;
        const copyId = await ports.send(to, link, threadId, raw);
        await store.saveThreadMessage(
            {
                guildLinkId: pair.guildLinkId,
                discordThreadId: pair.discordId,
                fluxerThreadId: pair.fluxerId,
                discordMessageId: from === 'discord' ? event.id : copyId,
                fluxerMessageId: from === 'fluxer' ? event.id : copyId,
            },
            now()
        );
        return 'relayed';
    }

    private park(parked: Parked) {
        // A forum post's first message has the post's own ID. The sync
        // posts it when it creates the post, so it is never parked.
        if (parked.event.id === parked.event.channelId) return;
        if (this.parked.length >= MAX_PARKED_MESSAGES) this.parked.shift();
        this.parked.push(parked);
    }

    async created(
        from: SnapshotSide,
        event: ThreadMessageEvent,
        raw: unknown
    ): Promise<void> {
        if (!this.deps.active()) return;
        await this.guarded('send', async () => {
            const result = await this.relay(from, event, raw);
            if (result === 'unmapped') {
                this.park({ from, event, raw, at: this.deps.now().getTime() });
            }
        });
    }

    /**
     * Retries messages held for threads that did not exist on the other
     * side. Called after each sync cycle, which is what creates them.
     */
    async flush(): Promise<void> {
        if (!this.deps.active()) return;
        const cutoff = this.deps.now().getTime() - PARKED_TTL_MS;
        const waiting = this.parked.filter((p) => p.at >= cutoff);
        this.parked = [];
        for (const parked of waiting) {
            await this.guarded('send', async () => {
                const result = await this.relay(
                    parked.from,
                    parked.event,
                    parked.raw
                );
                if (result === 'unmapped') this.parked.push(parked);
            });
        }
    }

    async edited(
        from: SnapshotSide,
        event: ThreadMessageEvent,
        raw: unknown
    ): Promise<void> {
        // A webhook edit is the relay's own write on this side.
        if (!this.deps.active() || event.webhookId || !event.parentId) return;
        const parentId = event.parentId;
        await this.guarded('edit', async () => {
            const copy = await this.deps.store.findThreadMessage(
                from,
                event.id
            );
            const link = copy ? await this.linkFor(from, parentId) : null;
            if (!copy || !link) return;
            const to = other(from);
            await this.deps.ports.edit(
                to,
                link,
                to === 'fluxer' ? copy.fluxerThreadId : copy.discordThreadId,
                to === 'fluxer' ? copy.fluxerMessageId : copy.discordMessageId,
                raw
            );
        });
    }

    /** `parentId` is the parent channel of the thread the message was in. */
    async deleted(
        from: SnapshotSide,
        messageId: string,
        parentId: string | null
    ): Promise<void> {
        if (!this.deps.active() || !parentId) return;
        await this.guarded('delete', async () => {
            const { store, ports } = this.deps;
            const copy = await store.findThreadMessage(from, messageId);
            const link = copy ? await this.linkFor(from, parentId) : null;
            if (!copy || !link) return;
            await store.deleteThreadMessage(from, messageId);
            const to = other(from);
            await ports.remove(
                to,
                link,
                to === 'fluxer' ? copy.fluxerThreadId : copy.discordThreadId,
                to === 'fluxer' ? copy.fluxerMessageId : copy.discordMessageId
            );
        });
    }
}

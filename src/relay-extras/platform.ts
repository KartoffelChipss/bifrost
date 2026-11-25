import {
    Routes as FluxerRoutes,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import { Routes, type Client as DiscordClient } from 'discord.js';
import type { PinPlatform } from './pinRelay';
import type { ReactionPlatform } from './reactionRelay';
import type { MessageRef, ReactionEmoji, Side } from './types';

/**
 * Reaction and pin calls on both platforms. Discord goes through discord.js
 * managers and routes; Fluxer through its REST client, which needs no
 * cached message or channel.
 */

/** Emoji path segment as discord.js MessageManager.react builds it. */
export function discordEmojiPath(emoji: ReactionEmoji): string {
    if (emoji.id === null) return encodeURIComponent(emoji.name);
    return `${emoji.animated ? 'a:' : ''}${emoji.name}:${emoji.id}`;
}

/** Emoji as @fluxerjs/util formatEmoji writes it; the route encodes it. */
export function fluxerEmojiPath(emoji: ReactionEmoji): string {
    if (emoji.id === null) return emoji.name;
    return `${emoji.animated ? 'a:' : ''}${emoji.name}:${emoji.id}`;
}

/** The part of a Fluxer API message the relay reads. */
interface FluxerMessageView {
    readonly pinned: boolean;
    readonly reactions: readonly {
        readonly emoji: { readonly id: string | null; readonly name: string };
        readonly count: number;
        readonly me: boolean;
    }[];
}

/** Validates the fields read from a Fluxer API message. */
export function parseFluxerMessage(raw: unknown): FluxerMessageView {
    const data = raw as { pinned?: unknown; reactions?: unknown } | null;
    if (typeof data?.pinned !== 'boolean') {
        throw new Error('Fluxer message has no pinned flag');
    }
    const list = Array.isArray(data.reactions) ? data.reactions : [];
    const reactions = list.flatMap((entry: unknown) => {
        const r = entry as {
            emoji?: { id?: unknown; name?: unknown };
            count?: unknown;
            me?: unknown;
        };
        if (typeof r?.count !== 'number' || !r.emoji) return [];
        const id = typeof r.emoji.id === 'string' ? r.emoji.id : null;
        const name = typeof r.emoji.name === 'string' ? r.emoji.name : '';
        return [{ emoji: { id, name }, count: r.count, me: r.me === true }];
    });
    return { pinned: data.pinned, reactions };
}

/** Users other than the bot in a reaction aggregate. */
export function othersIn(
    reactions: readonly {
        readonly emoji: {
            readonly id: string | null;
            readonly name: string | null;
        };
        readonly count: number | null;
        readonly me: boolean;
    }[],
    emoji: ReactionEmoji
): number {
    const match = reactions.find((r) =>
        emoji.id !== null
            ? r.emoji.id === emoji.id
            : r.emoji.id === null && r.emoji.name === emoji.name
    );
    if (!match) return 0;
    return Math.max(0, (match.count ?? 0) - (match.me ? 1 : 0));
}

export class ClientPlatform implements ReactionPlatform, PinPlatform {
    constructor(
        private readonly discord: DiscordClient,
        private readonly fluxerRef: { readonly current: FluxerClient | null }
    ) {}

    private fluxer(): FluxerClient {
        const client = this.fluxerRef.current;
        if (!client?.isReady()) throw new Error('Fluxer gateway is not ready');
        return client;
    }

    private async discordMessages(channelId: string) {
        const channel = await this.discord.channels.fetch(channelId);
        if (!channel?.isTextBased() || channel.isDMBased()) {
            throw new Error(`Discord channel ${channelId} has no messages`);
        }
        return channel.messages;
    }

    private async discordMessage(ref: MessageRef) {
        const messages = await this.discordMessages(ref.channelId);
        return messages.fetch({ message: ref.messageId, force: true });
    }

    private async fluxerMessage(ref: MessageRef): Promise<FluxerMessageView> {
        const route = FluxerRoutes.channelMessage(ref.channelId, ref.messageId);
        return parseFluxerMessage(await this.fluxer().rest.get(route));
    }

    private reactionRoute(side: Side, ref: MessageRef, emoji: ReactionEmoji) {
        return side === 'discord'
            ? Routes.channelMessageOwnReaction(
                  ref.channelId,
                  ref.messageId,
                  discordEmojiPath(emoji)
              )
            : FluxerRoutes.channelMessageReactionMe(
                  ref.channelId,
                  ref.messageId,
                  fluxerEmojiPath(emoji)
              );
    }

    async react(side: Side, ref: MessageRef, emoji: ReactionEmoji) {
        const route = this.reactionRoute(side, ref, emoji);
        if (side === 'discord') await this.discord.rest.put(route);
        else await this.fluxer().rest.put(route);
    }

    async unreact(side: Side, ref: MessageRef, emoji: ReactionEmoji) {
        const route = this.reactionRoute(side, ref, emoji);
        if (side === 'discord') await this.discord.rest.delete(route);
        else await this.fluxer().rest.delete(route);
    }

    async othersReacting(side: Side, ref: MessageRef, emoji: ReactionEmoji) {
        if (side === 'fluxer') {
            return othersIn((await this.fluxerMessage(ref)).reactions, emoji);
        }
        const message = await this.discordMessage(ref);
        return othersIn([...message.reactions.cache.values()], emoji);
    }

    /** Parent channels a Discord channel can have: a thread's, a category. */
    private static readonly MAX_ANCESTORS = 2;

    /** The channel, its parent and its parent's parent, as far as known. */
    async discordLineage(channelId: string): Promise<string[]> {
        const ids = [channelId];
        let current = channelId;
        for (let i = 0; i < ClientPlatform.MAX_ANCESTORS; i++) {
            const channel =
                this.discord.channels.cache.get(current) ??
                (await this.discord.channels.fetch(current).catch(() => null));
            const parent =
                channel && 'parentId' in channel ? channel.parentId : null;
            if (!parent) break;
            ids.push(parent);
            current = parent;
        }
        return ids;
    }

    async pinned(side: Side, ref: MessageRef): Promise<boolean> {
        if (side === 'fluxer') return (await this.fluxerMessage(ref)).pinned;
        return (await this.discordMessage(ref)).pinned;
    }

    async setPinned(side: Side, ref: MessageRef, pinned: boolean) {
        if (side === 'discord') {
            const messages = await this.discordMessages(ref.channelId);
            if (pinned) await messages.pin(ref.messageId);
            else await messages.unpin(ref.messageId);
            return;
        }
        const route = FluxerRoutes.channelPinMessage(
            ref.channelId,
            ref.messageId
        );
        if (pinned) await this.fluxer().rest.put(route);
        else await this.fluxer().rest.delete(route);
    }
}

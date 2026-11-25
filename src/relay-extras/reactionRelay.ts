import type { AddonLogger } from '../addons/isolation';
import type { FindPair } from './pairs';
import { KeyedQueue } from './queue';
import {
    guarded,
    otherSide,
    type MessageRef,
    type ReactionEmoji,
    type Side,
} from './types';

/**
 * Mirrors reactions on relayed messages. A bot can react only as itself,
 * so the counterpart carries one reaction from the bot per emoji:
 *
 * - The bot reacts when the first user reacts with an emoji on the source.
 * - The bot removes its reaction when the last user other than the bot
 *   removes theirs; the source message is read again to count them.
 * - Reactions by the bot itself are ignored on both sides. The bot's
 *   mirrored reaction on one side is therefore never mirrored back.
 * - A custom emoji without a pair in guild-sync's object map is skipped.
 */

/** The reaction calls the relay makes on either platform. */
export interface ReactionPlatform {
    react(side: Side, ref: MessageRef, emoji: ReactionEmoji): Promise<void>;
    unreact(side: Side, ref: MessageRef, emoji: ReactionEmoji): Promise<void>;
    /** Users other than the bot reacting with `emoji` now. */
    othersReacting(
        side: Side,
        ref: MessageRef,
        emoji: ReactionEmoji
    ): Promise<number>;
}

export interface ReactionEvent {
    readonly messageId: string;
    /** Null when a moderator removed every reaction of an emoji. */
    readonly userId: string | null;
    readonly emoji: ReactionEmoji;
    /**
     * Users other than the bot reacting with this emoji after the event,
     * when the event carries an exact count. Null when it does not.
     */
    readonly others: number | null;
}

export interface ReactionRelayDeps {
    readonly findPair: FindPair;
    readonly emojis: {
        translate(
            from: Side,
            guildLinkId: string,
            emoji: ReactionEmoji
        ): Promise<ReactionEmoji | null>;
    };
    readonly platform: ReactionPlatform;
    /** The bot's own user ID on `side`, or null before it is logged in. */
    readonly botId: (side: Side) => string | null;
    /** False while add-ons are read-only. */
    readonly active: () => boolean;
    readonly logger: AddonLogger;
}

const emojiKey = (emoji: ReactionEmoji) => emoji.id ?? emoji.name;

export class ReactionRelay {
    private readonly queue = new KeyedQueue();

    constructor(private readonly deps: ReactionRelayDeps) {}

    private ignored(from: Side, event: ReactionEvent): boolean {
        if (!this.deps.active()) return true;
        return event.userId !== null && event.userId === this.deps.botId(from);
    }

    /** Queues work per source message and emoji, so order is kept. */
    private enqueue(
        from: Side,
        event: ReactionEvent,
        what: string,
        work: () => Promise<void>
    ): Promise<void> {
        const key = `${from}:${event.messageId}:${emojiKey(event.emoji)}`;
        return this.queue.run(key, () =>
            guarded(this.deps.logger, `reaction ${what}`, work)
        );
    }

    /** The counterpart message and the emoji to use there, if mirrored. */
    private async target(from: Side, event: ReactionEvent) {
        const pair = await this.deps.findPair(from, event.messageId);
        if (!pair) return null;
        const emoji = await this.deps.emojis.translate(
            from,
            pair.guildLinkId,
            event.emoji
        );
        if (!emoji) return null;
        const to = otherSide(from);
        return { pair, to, ref: pair[to], emoji };
    }

    added(from: Side, event: ReactionEvent): Promise<void> {
        if (this.ignored(from, event)) return Promise.resolve();
        // Someone else reacted first; the bot's reaction is already there.
        if (event.others !== null && event.others > 1) return Promise.resolve();
        return this.enqueue(from, event, 'add', async () => {
            const target = await this.target(from, event);
            if (!target) return;
            await this.deps.platform.react(target.to, target.ref, target.emoji);
        });
    }

    removed(from: Side, event: ReactionEvent): Promise<void> {
        if (this.ignored(from, event)) return Promise.resolve();
        return this.enqueue(from, event, 'remove', async () => {
            const target = await this.target(from, event);
            if (!target) return;
            const others =
                event.others ??
                (await this.deps.platform.othersReacting(
                    from,
                    target.pair[from],
                    event.emoji
                ));
            if (others > 0) return;
            await this.deps.platform.unreact(
                target.to,
                target.ref,
                target.emoji
            );
        });
    }
}

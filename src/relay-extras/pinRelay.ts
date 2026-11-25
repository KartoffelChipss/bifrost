import type { AddonLogger } from '../addons/isolation';
import type { FindPair } from './pairs';
import { guarded, otherSide, type MessageRef, type Side } from './types';

/**
 * Mirrors pins on relayed messages. When a relayed message is pinned or
 * unpinned, its counterpart follows. A pin change the bot itself made is
 * remembered for {@link PIN_ECHO_TTL_MS}, so its update event is not
 * mirrored back.
 */

/** Long enough for the platform to send the update for the bot's change. */
export const PIN_ECHO_TTL_MS = 30_000;
/** Upper bound on remembered pin changes. */
export const MAX_PIN_ECHOES = 1_000;

export interface PinPlatform {
    /** Whether the message is pinned now. */
    pinned(side: Side, ref: MessageRef): Promise<boolean>;
    setPinned(side: Side, ref: MessageRef, pinned: boolean): Promise<void>;
}

export interface PinEvent {
    readonly messageId: string;
    /** Pinned state after the update, or null when the event lacks it. */
    readonly pinned: boolean | null;
    /** Pinned state before the update, or null when it was not cached. */
    readonly previous: boolean | null;
}

export interface PinRelayDeps {
    readonly findPair: FindPair;
    readonly platform: PinPlatform;
    /** False while add-ons are read-only. */
    readonly active: () => boolean;
    readonly now: () => number;
    readonly logger: AddonLogger;
}

export class PinRelay {
    /** `side:messageId:state` of the bot's own pin changes, to expiry. */
    private readonly echoes = new Map<string, number>();

    constructor(private readonly deps: PinRelayDeps) {}

    private remember(side: Side, messageId: string, pinned: boolean) {
        const now = this.deps.now();
        for (const [key, expiry] of this.echoes) {
            if (expiry > now && this.echoes.size < MAX_PIN_ECHOES) break;
            this.echoes.delete(key);
        }
        this.echoes.set(
            `${side}:${messageId}:${pinned}`,
            now + PIN_ECHO_TTL_MS
        );
    }

    /** True, once, for an update caused by the bot's own pin change. */
    private consumeEcho(side: Side, messageId: string, pinned: boolean) {
        const key = `${side}:${messageId}:${pinned}`;
        const expiry = this.echoes.get(key);
        if (expiry === undefined) return false;
        this.echoes.delete(key);
        return expiry > this.deps.now();
    }

    changed(from: Side, event: PinEvent): Promise<void> {
        const { pinned, previous } = event;
        // Most updates are edits that leave the pin as it was.
        if (pinned !== null && previous !== null && pinned === previous)
            return Promise.resolve();
        if (pinned !== null && this.consumeEcho(from, event.messageId, pinned))
            return Promise.resolve();
        if (!this.deps.active()) return Promise.resolve();
        return guarded(this.deps.logger, 'pin', () => this.mirror(from, event));
    }

    private async mirror(from: Side, event: PinEvent): Promise<void> {
        const { findPair, platform } = this.deps;
        const pair = await findPair(from, event.messageId);
        if (!pair) return;
        const state = event.pinned ?? (await platform.pinned(from, pair[from]));
        if (
            event.pinned === null &&
            this.consumeEcho(from, event.messageId, state)
        )
            return;
        const to = otherSide(from);
        const target = pair[to];
        // Without the old state, only a difference shows the pin changed.
        if (event.previous === null || event.pinned === null) {
            if ((await platform.pinned(to, target)) === state) return;
        }
        this.remember(to, target.messageId, state);
        await platform.setPinned(to, target, state);
    }
}

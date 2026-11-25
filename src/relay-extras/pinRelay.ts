import type { AddonLogger } from '../addons/isolation';
import type { FindPair } from './pairs';
import { KeyedQueue } from './queue';
import { guarded, otherSide, type MessageRef, type Side } from './types';

/**
 * Mirrors pins on relayed messages. When a relayed message is pinned or
 * unpinned, its counterpart follows. A pin change the bot itself made is
 * remembered for {@link PIN_ECHO_TTL_MS}, so its update event is not
 * mirrored back.
 *
 * Every message update reaches the relay, and most are edits. An update
 * is treated as a pin change only on positive evidence:
 *
 * - the cached old message shows a different pin state, or
 * - the platform reported a pin change in the message's channel
 *   (CHANNEL_PINS_UPDATE) within {@link PIN_EVIDENCE_MS}.
 *
 * Without either, the old state is unknown and the update is ignored. A
 * difference from the counterpart alone is not evidence: the two copies
 * can differ for other reasons, and mirroring that difference on an edit
 * would swap the pin from one side to the other.
 *
 * Pin work runs one at a time per source message, in event order.
 */

/** Long enough for the platform to send the update for the bot's change. */
export const PIN_ECHO_TTL_MS = 30_000;
/** Upper bound on remembered pin changes. */
export const MAX_PIN_ECHOES = 1_000;
/** How recent a channel's pin change must be to explain an update. */
export const PIN_EVIDENCE_MS = 5_000;
/**
 * Discord may send the channel's pin event just after the message update,
 * so an update without evidence waits this long once before it is ignored.
 */
export const PIN_EVIDENCE_WAIT_MS = 1_500;
/** Upper bound on channels with a remembered pin change. */
export const MAX_PIN_EVIDENCE = 1_000;

export interface PinPlatform {
    /** Whether the message is pinned now. */
    pinned(side: Side, ref: MessageRef): Promise<boolean>;
    setPinned(side: Side, ref: MessageRef, pinned: boolean): Promise<void>;
}

export interface PinEvent {
    readonly messageId: string;
    /** The channel (or thread) the message is in. */
    readonly channelId: string;
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
    /** Waits; defaults to a timer. */
    readonly sleep?: (ms: number) => Promise<void>;
    readonly logger: AddonLogger;
}

const timer = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keeps at most `max` keys, dropping expired and then oldest entries. */
function pruneTimes(
    times: Map<string, number>,
    max: number,
    alive: (at: number) => boolean
): void {
    for (const [key, at] of times) {
        if (alive(at) && times.size < max) break;
        times.delete(key);
    }
}

export class PinRelay {
    /** `side:messageId:state` of the bot's own pin changes, to expiry. */
    private readonly echoes = new Map<string, number>();
    /** `side:channelId` to the time of the channel's last pin change. */
    private readonly evidence = new Map<string, number>();
    private readonly queue = new KeyedQueue();

    constructor(private readonly deps: PinRelayDeps) {}

    private remember(side: Side, messageId: string, pinned: boolean) {
        const now = this.deps.now();
        pruneTimes(this.echoes, MAX_PIN_ECHOES, (expiry) => expiry > now);
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

    /** Records that the platform reported a pin change in a channel. */
    pinsChanged(side: Side, channelId: string): void {
        const now = this.deps.now();
        const key = `${side}:${channelId}`;
        this.evidence.delete(key);
        pruneTimes(
            this.evidence,
            MAX_PIN_EVIDENCE,
            (at) => now - at <= PIN_EVIDENCE_MS
        );
        this.evidence.set(key, now);
    }

    private recentPinChange(side: Side, channelId: string): boolean {
        const at = this.evidence.get(`${side}:${channelId}`);
        return at !== undefined && this.deps.now() - at <= PIN_EVIDENCE_MS;
    }

    /** True when the channel had a pin change, waiting once for it. */
    private async pinEvidence(side: Side, channelId: string) {
        if (this.recentPinChange(side, channelId)) return true;
        await (this.deps.sleep ?? timer)(PIN_EVIDENCE_WAIT_MS);
        return this.recentPinChange(side, channelId);
    }

    changed(from: Side, event: PinEvent): Promise<void> {
        const { pinned, previous } = event;
        // Most updates are edits that leave the pin as it was.
        if (pinned !== null && previous !== null && pinned === previous)
            return Promise.resolve();
        if (pinned !== null && this.consumeEcho(from, event.messageId, pinned))
            return Promise.resolve();
        if (!this.deps.active()) return Promise.resolve();
        return this.queue.run(`${from}:${event.messageId}`, () =>
            guarded(this.deps.logger, 'pin', () => this.mirror(from, event))
        );
    }

    private async mirror(from: Side, event: PinEvent): Promise<void> {
        const { findPair, platform } = this.deps;
        // The cached old state differs from the new one: a known change.
        const known = event.pinned !== null && event.previous !== null;
        if (!known && !(await this.pinEvidence(from, event.channelId))) return;
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
        // The channel's pin change may have been another message's.
        if (!known && (await platform.pinned(to, target)) === state) return;
        this.remember(to, target.messageId, state);
        await platform.setPinned(to, target, state);
    }
}

import type { PinPlatform } from '../../src/relay-extras/pinRelay';
import type { ReactionPlatform } from '../../src/relay-extras/reactionRelay';
import type {
    MessagePair,
    MessageRef,
    ReactionEmoji,
    Side,
} from '../../src/relay-extras/types';

export const PAIR: MessagePair = {
    guildLinkId: 'link-1',
    discord: { channelId: 'd-chan', messageId: 'd-msg' },
    fluxer: { channelId: 'f-chan', messageId: 'f-msg' },
};

export const THUMBS: ReactionEmoji = { id: null, name: '👍', animated: false };

/** Finds PAIR by either message ID. */
export async function findPairFake(side: Side, messageId: string) {
    return PAIR[side].messageId === messageId ? PAIR : null;
}

const ref = (r: MessageRef) => `${r.channelId}/${r.messageId}`;
const emo = (e: ReactionEmoji) => (e.id ? `${e.name}:${e.id}` : e.name);

/** Records every platform call; state is set by the test. */
export class FakePlatform implements ReactionPlatform, PinPlatform {
    calls: string[] = [];
    others = 0;
    pins = new Map<string, boolean>();
    fail: Error | null = null;
    /** Calls (by first word) that take 10 ms, to test ordering. */
    slow = new Set<string>();

    private async step(call: string) {
        if (this.slow.has(call.split(' ')[0])) {
            await new Promise((r) => setTimeout(r, 10));
        }
        if (this.fail) throw this.fail;
        this.calls.push(call);
    }

    async react(side: Side, r: MessageRef, e: ReactionEmoji) {
        await this.step(`react ${side} ${ref(r)} ${emo(e)}`);
    }

    async unreact(side: Side, r: MessageRef, e: ReactionEmoji) {
        await this.step(`unreact ${side} ${ref(r)} ${emo(e)}`);
    }

    async othersReacting(side: Side, r: MessageRef, e: ReactionEmoji) {
        await this.step(`count ${side} ${ref(r)} ${emo(e)}`);
        return this.others;
    }

    async pinned(side: Side, r: MessageRef) {
        await this.step(`pinned? ${side} ${ref(r)}`);
        return this.pins.get(`${side}:${r.messageId}`) ?? false;
    }

    async setPinned(side: Side, r: MessageRef, pinned: boolean) {
        await this.step(`${pinned ? 'pin' : 'unpin'} ${side} ${ref(r)}`);
        this.pins.set(`${side}:${r.messageId}`, pinned);
    }
}

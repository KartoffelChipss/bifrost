import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    PIN_ECHO_TTL_MS,
    PIN_EVIDENCE_MS,
    PIN_EVIDENCE_WAIT_MS,
    PinRelay,
} from '../../src/relay-extras/pinRelay';
import { createRecordingLogger } from '../addons/fakes';
import { FakePlatform, findPairFake } from './fakes';

function setup() {
    const platform = new FakePlatform();
    const logger = createRecordingLogger();
    const state = {
        active: true,
        now: 0,
        slept: [] as number[],
        // Runs while the relay waits for a channel pin event.
        duringSleep: null as (() => void) | null,
    };
    const relay = new PinRelay({
        findPair: findPairFake,
        platform,
        active: () => state.active,
        now: () => state.now,
        sleep: async (ms) => {
            state.slept.push(ms);
            state.duringSleep?.();
        },
        logger,
    });
    return { platform, logger, state, relay };
}

const D = { messageId: 'd-msg', channelId: 'd-chan' };
const F = { messageId: 'f-msg', channelId: 'f-chan' };

describe('PinRelay', () => {
    it('ignores an update that left the pin as it was', async () => {
        const { platform, relay } = setup();
        await relay.changed('discord', {
            ...D,
            pinned: false,
            previous: false,
        });
        assert.deepEqual(platform.calls, []);
    });

    it('pins the counterpart when the old state shows a change', async () => {
        const { platform, relay } = setup();
        await relay.changed('discord', { ...D, pinned: true, previous: false });
        assert.deepEqual(platform.calls, ['pin fluxer f-chan/f-msg']);
    });

    it("ignores the update caused by the bot's own pin, once", async () => {
        const { platform, relay } = setup();
        await relay.changed('discord', { ...D, pinned: true, previous: false });
        const echo = { ...F, pinned: true, previous: false };
        await relay.changed('fluxer', echo);
        assert.deepEqual(platform.calls, ['pin fluxer f-chan/f-msg']);
        await relay.changed('fluxer', echo);
        assert.equal(
            platform.calls[platform.calls.length - 1],
            'pin discord d-chan/d-msg'
        );
    });

    it('mirrors again once the remembered change has expired', async () => {
        const { platform, relay, state } = setup();
        await relay.changed('discord', { ...D, pinned: false, previous: true });
        state.now = PIN_ECHO_TTL_MS + 1;
        await relay.changed('fluxer', { ...F, pinned: false, previous: true });
        assert.deepEqual(platform.calls, [
            'unpin fluxer f-chan/f-msg',
            'unpin discord d-chan/d-msg',
        ]);
    });

    it('ignores an uncached update without a channel pin event', async () => {
        const { platform, relay, state } = setup();
        // An edit of an unpinned message whose copy is pinned: the old
        // relay unpinned the copy here, swapping the pin to one side.
        platform.pins.set('fluxer:f-msg', true);
        await relay.changed('discord', { ...D, pinned: false, previous: null });
        assert.deepEqual(platform.calls, []);
        assert.deepEqual(state.slept, [PIN_EVIDENCE_WAIT_MS]);
    });

    it('mirrors an uncached update after a recent channel pin event', async () => {
        const { platform, relay, state } = setup();
        relay.pinsChanged('discord', 'd-chan');
        state.now = PIN_EVIDENCE_MS;
        await relay.changed('discord', { ...D, pinned: true, previous: null });
        assert.deepEqual(platform.calls, [
            'pinned? fluxer f-chan/f-msg',
            'pin fluxer f-chan/f-msg',
        ]);
        assert.deepEqual(state.slept, []);
    });

    it('waits once for a channel pin event that comes just after', async () => {
        const { platform, relay, state } = setup();
        state.duringSleep = () => relay.pinsChanged('discord', 'd-chan');
        await relay.changed('discord', { ...D, pinned: true, previous: null });
        assert.deepEqual(platform.calls, [
            'pinned? fluxer f-chan/f-msg',
            'pin fluxer f-chan/f-msg',
        ]);
    });

    it('treats an old or other-channel pin event as no evidence', async () => {
        const { platform, relay, state } = setup();
        relay.pinsChanged('discord', 'd-chan');
        relay.pinsChanged('fluxer', 'd-chan');
        relay.pinsChanged('discord', 'elsewhere');
        state.now = PIN_EVIDENCE_MS + 1;
        relay.pinsChanged('discord', 'elsewhere');
        await relay.changed('discord', { ...D, pinned: true, previous: null });
        assert.deepEqual(platform.calls, []);
    });

    it('with evidence, pins only when the counterpart differs', async () => {
        const { platform, relay } = setup();
        relay.pinsChanged('discord', 'd-chan');
        platform.pins.set('fluxer:f-msg', true);
        await relay.changed('discord', { ...D, pinned: true, previous: null });
        assert.deepEqual(platform.calls, ['pinned? fluxer f-chan/f-msg']);
    });

    it('reads the source when the update lacks the pinned flag', async () => {
        const { platform, relay } = setup();
        relay.pinsChanged('fluxer', 'f-chan');
        platform.pins.set('fluxer:f-msg', true);
        await relay.changed('fluxer', { ...F, pinned: null, previous: null });
        assert.deepEqual(platform.calls, [
            'pinned? fluxer f-chan/f-msg',
            'pinned? discord d-chan/d-msg',
            'pin discord d-chan/d-msg',
        ]);
    });

    it('runs pin work for one message in event order', async () => {
        const { platform, relay } = setup();
        platform.slow.add('pin');
        const pin = relay.changed('discord', {
            ...D,
            pinned: true,
            previous: false,
        });
        const unpin = relay.changed('discord', {
            ...D,
            pinned: false,
            previous: true,
        });
        await Promise.all([pin, unpin]);
        assert.deepEqual(platform.calls, [
            'pin fluxer f-chan/f-msg',
            'unpin fluxer f-chan/f-msg',
        ]);
    });

    it('skips messages that were not relayed and read-only mode', async () => {
        const { platform, relay, state } = setup();
        const change = { channelId: 'd-chan', pinned: true, previous: false };
        await relay.changed('discord', { messageId: 'other', ...change });
        state.active = false;
        await relay.changed('discord', { messageId: 'd-msg', ...change });
        assert.deepEqual(platform.calls, []);
    });

    it('logs a failed pin and never throws', async () => {
        const { platform, relay, logger } = setup();
        platform.fail = new Error('Missing Permissions');
        await relay.changed('discord', { ...D, pinned: true, previous: false });
        assert.equal(logger.entries[0]?.level, 'warn');
        assert.match(logger.entries[0].message, /pin: Missing Permissions/);
    });
});

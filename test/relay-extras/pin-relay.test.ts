import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PIN_ECHO_TTL_MS, PinRelay } from '../../src/relay-extras/pinRelay';
import { createRecordingLogger } from '../addons/fakes';
import { FakePlatform, findPairFake } from './fakes';

function setup() {
    const platform = new FakePlatform();
    const logger = createRecordingLogger();
    const state = { active: true, now: 0 };
    const relay = new PinRelay({
        findPair: findPairFake,
        platform,
        active: () => state.active,
        now: () => state.now,
        logger,
    });
    return { platform, logger, state, relay };
}

describe('PinRelay', () => {
    it('ignores an update that left the pin as it was', async () => {
        const { platform, relay } = setup();
        await relay.changed('discord', {
            messageId: 'd-msg',
            pinned: false,
            previous: false,
        });
        assert.deepEqual(platform.calls, []);
    });

    it('pins the counterpart when the old state shows a change', async () => {
        const { platform, relay } = setup();
        await relay.changed('discord', {
            messageId: 'd-msg',
            pinned: true,
            previous: false,
        });
        assert.deepEqual(platform.calls, ['pin fluxer f-chan/f-msg']);
    });

    it("ignores the update caused by the bot's own pin, once", async () => {
        const { platform, relay } = setup();
        await relay.changed('discord', {
            messageId: 'd-msg',
            pinned: true,
            previous: false,
        });
        const echo = { messageId: 'f-msg', pinned: true, previous: false };
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
        await relay.changed('discord', {
            messageId: 'd-msg',
            pinned: false,
            previous: true,
        });
        state.now = PIN_ECHO_TTL_MS + 1;
        await relay.changed('fluxer', {
            messageId: 'f-msg',
            pinned: false,
            previous: true,
        });
        assert.deepEqual(platform.calls, [
            'unpin fluxer f-chan/f-msg',
            'unpin discord d-chan/d-msg',
        ]);
    });

    it('without the old state, pins only when the counterpart differs', async () => {
        const { platform, relay } = setup();
        const event = { messageId: 'd-msg', pinned: true, previous: null };
        await relay.changed('discord', event);
        // The counterpart is pinned now; the next update changes nothing.
        await relay.changed('discord', event);
        assert.deepEqual(platform.calls, [
            'pinned? fluxer f-chan/f-msg',
            'pin fluxer f-chan/f-msg',
            'pinned? fluxer f-chan/f-msg',
        ]);
    });

    it('reads the source when the update lacks the pinned flag', async () => {
        const { platform, relay } = setup();
        platform.pins.set('fluxer:f-msg', true);
        await relay.changed('fluxer', {
            messageId: 'f-msg',
            pinned: null,
            previous: null,
        });
        assert.deepEqual(platform.calls, [
            'pinned? fluxer f-chan/f-msg',
            'pinned? discord d-chan/d-msg',
            'pin discord d-chan/d-msg',
        ]);
    });

    it('skips messages that were not relayed and read-only mode', async () => {
        const { platform, relay, state } = setup();
        const change = { pinned: true, previous: false };
        await relay.changed('discord', { messageId: 'other', ...change });
        state.active = false;
        await relay.changed('discord', { messageId: 'd-msg', ...change });
        assert.deepEqual(platform.calls, []);
    });

    it('logs a failed pin and never throws', async () => {
        const { platform, relay, logger } = setup();
        platform.fail = new Error('Missing Permissions');
        await relay.changed('discord', {
            messageId: 'd-msg',
            pinned: true,
            previous: false,
        });
        assert.equal(logger.entries[0]?.level, 'warn');
        assert.match(logger.entries[0].message, /pin: Missing Permissions/);
    });
});

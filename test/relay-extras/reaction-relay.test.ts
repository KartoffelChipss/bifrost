import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ReactionRelay,
    type ReactionEvent,
} from '../../src/relay-extras/reactionRelay';
import type { ReactionEmoji, Side } from '../../src/relay-extras/types';
import { createRecordingLogger } from '../addons/fakes';
import { FakePlatform, findPairFake, THUMBS } from './fakes';

const CUSTOM_D: ReactionEmoji = {
    id: 'd-emoji',
    name: 'party',
    animated: false,
};
const CUSTOM_F: ReactionEmoji = {
    id: 'f-emoji',
    name: 'party',
    animated: true,
};

function setup() {
    const platform = new FakePlatform();
    const logger = createRecordingLogger();
    const state = { active: true, mapped: true };
    const relay = new ReactionRelay({
        findPair: findPairFake,
        emojis: {
            async translate(_from, _link, emoji) {
                if (emoji.id === null) return emoji;
                return state.mapped ? CUSTOM_F : null;
            },
        },
        platform,
        botId: (side: Side) => (side === 'discord' ? 'd-bot' : 'f-bot'),
        active: () => state.active,
        logger,
    });
    return { platform, logger, state, relay };
}

const event = (over: Partial<ReactionEvent> = {}): ReactionEvent => ({
    messageId: 'd-msg',
    userId: 'alice',
    emoji: THUMBS,
    others: null,
    ...over,
});

describe('ReactionRelay.added', () => {
    it('reacts as the bot on the counterpart for the first user', async () => {
        const { platform, relay } = setup();
        await relay.added('discord', event({ others: 1 }));
        assert.deepEqual(platform.calls, ['react fluxer f-chan/f-msg 👍']);
    });

    it('reacts when the count is unknown, Fluxer to Discord', async () => {
        const { platform, relay } = setup();
        await relay.added('fluxer', event({ messageId: 'f-msg' }));
        assert.deepEqual(platform.calls, ['react discord d-chan/d-msg 👍']);
    });

    it('skips a later user, whose emoji the bot already mirrored', async () => {
        const { platform, relay } = setup();
        await relay.added('discord', event({ others: 2 }));
        assert.deepEqual(platform.calls, []);
    });

    it("ignores the bot's own reactions on both sides", async () => {
        const { platform, relay } = setup();
        await relay.added('discord', event({ userId: 'd-bot' }));
        await relay.added(
            'fluxer',
            event({ messageId: 'f-msg', userId: 'f-bot' })
        );
        assert.deepEqual(platform.calls, []);
    });

    it('maps a custom emoji and skips an unmapped one', async () => {
        const { platform, relay, state } = setup();
        await relay.added('discord', event({ emoji: CUSTOM_D }));
        state.mapped = false;
        await relay.added('discord', event({ emoji: CUSTOM_D }));
        assert.deepEqual(platform.calls, [
            'react fluxer f-chan/f-msg party:f-emoji',
        ]);
    });

    it('skips messages that were not relayed', async () => {
        const { platform, relay } = setup();
        await relay.added('discord', event({ messageId: 'other' }));
        assert.deepEqual(platform.calls, []);
    });

    it('does nothing while add-ons are read-only', async () => {
        const { platform, relay, state } = setup();
        state.active = false;
        await relay.added('discord', event());
        await relay.removed('discord', event());
        assert.deepEqual(platform.calls, []);
    });

    it('logs a platform failure and never throws', async () => {
        const { platform, relay, logger } = setup();
        platform.fail = new Error('Missing Permissions');
        await relay.added('discord', event());
        assert.equal(logger.entries.length, 1);
        assert.equal(logger.entries[0].level, 'warn');
        assert.match(logger.entries[0].message, /Missing Permissions/);
    });
});

describe('ReactionRelay.removed', () => {
    it('removes the bot reaction when no other user is left', async () => {
        const { platform, relay } = setup();
        platform.others = 0;
        await relay.removed('discord', event());
        assert.deepEqual(platform.calls, [
            'count discord d-chan/d-msg 👍',
            'unreact fluxer f-chan/f-msg 👍',
        ]);
    });

    it('keeps the bot reaction while others still react', async () => {
        const { platform, relay } = setup();
        platform.others = 1;
        await relay.removed('fluxer', event({ messageId: 'f-msg' }));
        assert.deepEqual(platform.calls, ['count fluxer f-chan/f-msg 👍']);
    });

    it('counts with the source emoji and unreacts with the mapped one', async () => {
        const { platform, relay } = setup();
        await relay.removed('discord', event({ emoji: CUSTOM_D }));
        assert.deepEqual(platform.calls, [
            'count discord d-chan/d-msg party:d-emoji',
            'unreact fluxer f-chan/f-msg party:f-emoji',
        ]);
    });

    it('trusts a known zero count, as when an emoji is cleared', async () => {
        const { platform, relay } = setup();
        await relay.removed('discord', event({ userId: null, others: 0 }));
        assert.deepEqual(platform.calls, ['unreact fluxer f-chan/f-msg 👍']);
    });

    it('keeps add and remove in event order', async () => {
        const { platform, relay } = setup();
        platform.slow.add('react');
        await Promise.all([
            relay.added('discord', event()),
            relay.removed('discord', event()),
        ]);
        assert.deepEqual(platform.calls, [
            'react fluxer f-chan/f-msg 👍',
            'count discord d-chan/d-msg 👍',
            'unreact fluxer f-chan/f-msg 👍',
        ]);
    });
});

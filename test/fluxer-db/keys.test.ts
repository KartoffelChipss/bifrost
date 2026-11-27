import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    FluxerKeyError,
    bucketOf,
    messagePartitionKey,
    messageRowKey,
    reactionRowKey,
    snowflakeTime,
} from '../../src/fluxer-db/keys';

// Keys read from the live Fluxer database on 2026-11-27.
const CHANNEL = '1575322911084904448';
const MESSAGE = '1575609360757817344';
const B = (id: string) => `{"__fluxer_type":"bigint","value":"${id}"}`;

describe('Fluxer row keys', () => {
    it('puts a message in its 10-day bucket', () => {
        assert.equal(bucketOf(MESSAGE), 434);
        assert.equal(bucketOf('0'), 0);
    });

    it('builds message keys exactly as Fluxer stores them', () => {
        assert.equal(
            messagePartitionKey(CHANNEL, MESSAGE),
            `${B(CHANNEL)}\u001f434`
        );
        assert.equal(
            messageRowKey(CHANNEL, MESSAGE),
            `${B(CHANNEL)}\u001f434\u001f${B(MESSAGE)}`
        );
    });

    it('builds a reaction key exactly as Fluxer stores it', () => {
        const key = reactionRowKey({
            channelId: CHANNEL,
            messageId: '1575543761256054784',
            emojiId: '0',
            emojiName: '🦃',
            userId: '1565044763378319360',
        });
        assert.equal(
            key,
            `${B(CHANNEL)}\u001f434\u001f${B('1575543761256054784')}\u001f${B('0')}\u001f"🦃"\u001f${B('1565044763378319360')}`
        );
    });

    it('reads the time a Discord ID encodes, as both share the epoch', () => {
        // Discord's documented example ID: 2016-04-30 11:18:25.796 UTC.
        assert.equal(
            snowflakeTime('175928847299117063').toISOString(),
            '2016-04-30T11:18:25.796Z'
        );
    });

    it('refuses anything that is not a snowflake', () => {
        assert.throws(() => bucketOf('12a'), FluxerKeyError);
        assert.throws(() => bucketOf(''), FluxerKeyError);
        assert.throws(() => bucketOf('99999999999999999999'), FluxerKeyError);
    });
});

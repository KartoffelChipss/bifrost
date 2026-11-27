import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bucketOf, messageRowKey } from '../../src/fluxer-db/keys';
import {
    originalFrom,
    planCopy,
    type PlanContext,
} from '../../src/history-rewrite/plan';

// A Discord message from 2019-05-01 and its 2026 Fluxer copy.
const DISCORD_ID = '573091117793280000';
const OLD_ID = '1575609360757817344';
const CHANNEL = '1575322911084904448';
const WEBHOOK = '1575407231271174147';
const BOT = '1565044763378319360';
const DATE = '*Originally posted 2019-05-01 10:19 UTC*';

const copy = {
    discordMessageId: DISCORD_ID,
    fluxerMessageId: OLD_ID,
    fluxerTargetId: CHANNEL,
    webhookId: WEBHOOK,
};

const big = (value: string) => ({ __fluxer_type: 'bigint', value });
const quote = {
    color: 0x0b0d0e,
    author: { name: 'jake ↩️' },
    description: 'hi',
};

function oldRow(fields: Record<string, unknown> = {}) {
    return {
        type: 0,
        flags: 0,
        bucket: bucketOf(OLD_ID),
        version: 1,
        channel_id: big(CHANNEL),
        message_id: big(OLD_ID),
        webhook_id: big(WEBHOOK),
        webhook_name: 'Jake',
        has_reaction: false,
        content: `hello\nReactions: 👍 3 · :pog: 1\n${DATE}`,
        embeds: [quote, { title: 'link' }],
        ...fields,
    };
}

const context: PlanContext = {
    botUserId: BOT,
    emojis: new Map([['111', '222']]),
    replyTarget: (id) =>
        id === '573091000000000000'
            ? {
                  fluxerChannelId: CHANNEL,
                  fluxerMessageId: '573091000000000000',
              }
            : null,
};

const raw = {
    type: 19,
    edited_timestamp: '2019-05-01T11:00:00.000000+00:00',
    message_reference: { message_id: '573091000000000000' },
    reactions: [
        { emoji: { id: null, name: '👍' }, count: 3 },
        { emoji: { id: '111', name: 'pog', animated: true }, count: 1 },
        { emoji: { id: '999', name: 'unsynced' }, count: 2 },
    ],
};

describe('planCopy', () => {
    it('moves the copy to its Discord ID with native fields', () => {
        const result = planCopy(copy, oldRow(), originalFrom(raw), context);
        assert.ok(result.ok);
        const { plan } = result;
        const data = plan.message.rowData;
        assert.equal(plan.message.rowKey, messageRowKey(CHANNEL, DISCORD_ID));
        assert.equal(plan.oldRowKey, messageRowKey(CHANNEL, OLD_ID));
        assert.equal(plan.message.sortId, DISCORD_ID);
        assert.deepEqual(data.message_id, big(DISCORD_ID));
        assert.equal(data.bucket, bucketOf(DISCORD_ID));
        assert.equal(data.content, 'hello');
        assert.deepEqual(data.embeds, [{ title: 'link' }]);
        assert.deepEqual(data.message_reference, {
            type: 0,
            guild_id: null,
            channel_id: big(CHANNEL),
            message_id: big('573091000000000000'),
        });
        assert.deepEqual(data.edited_timestamp, {
            __fluxer_type: 'date',
            value: '2019-05-01T11:00:00.000Z',
        });
        assert.equal(data.has_reaction, true);
        assert.equal(data.webhook_name, 'Jake');
        assert.equal(plan.nativeReply, true);
    });

    it('adds one bot reaction per emoji it can show', () => {
        const result = planCopy(copy, oldRow(), originalFrom(raw), context);
        assert.ok(result.ok);
        const reactions = result.plan.reactions.map((r) => r.rowData);
        assert.deepEqual(
            reactions.map((r) => [
                r.emoji_name,
                (r.emoji_id as { value: string }).value,
                r.emoji_animated,
            ]),
            [
                ['👍', '0', false],
                ['pog', '222', true],
            ]
        );
        assert.deepEqual(reactions[0]?.user_id, big(BOT));
    });

    it('keeps the quote when the replied-to copy is elsewhere', () => {
        const elsewhere = { ...raw, message_reference: { message_id: '1' } };
        const result = planCopy(
            copy,
            oldRow(),
            originalFrom(elsewhere),
            context
        );
        assert.ok(result.ok);
        assert.equal(result.plan.nativeReply, false);
        assert.equal(result.plan.message.rowData.message_reference, undefined);
        assert.equal(
            (result.plan.message.rowData.embeds as unknown[]).length,
            2
        );
    });

    it('refuses rows that are not exactly the copy bifrost posted', () => {
        const original = originalFrom(raw);
        const reasons = [
            planCopy(copy, oldRow({ webhook_id: big('5') }), original, context),
            planCopy(copy, oldRow({ author_id: big('5') }), original, context),
            planCopy(copy, oldRow({ content: 'no date' }), original, context),
            planCopy(
                { ...copy, fluxerMessageId: '1' },
                oldRow(),
                original,
                context
            ),
        ].map((r) => (r.ok ? 'ok' : r.reason));
        assert.deepEqual(reasons, [
            'webhook does not match',
            'row has a user author',
            'no date note',
            'Discord ID is not older than the copy',
        ]);
    });

    it('reads a redacted original as having nothing to add', () => {
        assert.deepEqual(originalFrom(null), {
            editedAt: null,
            replyTo: null,
            reactions: [],
        });
    });
});

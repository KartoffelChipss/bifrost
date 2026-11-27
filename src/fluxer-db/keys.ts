/**
 * Fluxer's key format for rows in its `fluxer_kv` table, for the few
 * writes bifrost makes there directly (docs/design/history-rewrite.md).
 *
 * Source, Fluxer commit 58062ed2:
 * - Each key part is `JSON.stringify(encodeValue(part))`, joined with
 *   U+001F (fluxer_api/src/api/database/PostgresKvQueryExecutor.ts:105,
 *   281-287).
 * - A bigint encodes as {"__fluxer_type":"bigint","value":"<decimal>"},
 *   in that key order (PostgresKvQueryExecutor.ts:205-229).
 * - A message's bucket is its 10-day window:
 *   (id >> 22) / 864000000 (packages/snowflake/src/SnowflakeBuckets.ts).
 */

const SEPARATOR = '\u001f';
const SNOWFLAKE = /^\d{1,20}$/;
/** 2^64: a snowflake is an unsigned 64-bit number. */
const MAX_SNOWFLAKE = BigInt('18446744073709551616');
const TIMESTAMP_SHIFT = BigInt(22);
const BUCKET_MS = BigInt(864_000_000);
/** Fluxer and Discord share this epoch (packages/constants/src/Core.ts:3). */
export const SNOWFLAKE_EPOCH_MS = BigInt(1_420_070_400_000);

export class FluxerKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FluxerKeyError';
    }
}

/** Checks a snowflake string and returns it as a bigint. */
export function snowflake(id: string): bigint {
    if (!SNOWFLAKE.test(id)) throw new FluxerKeyError(`Not a snowflake: ${id}`);
    const value = BigInt(id);
    if (value >= MAX_SNOWFLAKE) throw new FluxerKeyError(`Out of range: ${id}`);
    return value;
}

/** A bigint as Fluxer stores it inside row_data. */
export function bigintValue(id: string): {
    __fluxer_type: 'bigint';
    value: string;
} {
    return { __fluxer_type: 'bigint', value: snowflake(id).toString() };
}

/** A bigint key part, exactly as Fluxer writes it. */
export function bigintPart(id: string): string {
    return JSON.stringify(bigintValue(id));
}

/** The 10-day bucket a message ID falls in. */
export function bucketOf(messageId: string): number {
    return Number((snowflake(messageId) >> TIMESTAMP_SHIFT) / BUCKET_MS);
}

/** The time a snowflake encodes. */
export function snowflakeTime(id: string): Date {
    const ms = (snowflake(id) >> TIMESTAMP_SHIFT) + SNOWFLAKE_EPOCH_MS;
    return new Date(Number(ms));
}

/** Partition key of a `messages` row: channel and bucket. */
export function messagePartitionKey(channelId: string, messageId: string) {
    return [bigintPart(channelId), String(bucketOf(messageId))].join(SEPARATOR);
}

/** Row key of a `messages` row: channel, bucket and message. */
export function messageRowKey(channelId: string, messageId: string): string {
    return [
        messagePartitionKey(channelId, messageId),
        bigintPart(messageId),
    ].join(SEPARATOR);
}

/**
 * Row key of a `message_reactions` row: channel, bucket, message, emoji
 * ID (0 for a Unicode emoji), emoji name and user (Tables.ts:752-757).
 */
export function reactionRowKey(fields: {
    channelId: string;
    messageId: string;
    emojiId: string;
    emojiName: string;
    userId: string;
}): string {
    return [
        messagePartitionKey(fields.channelId, fields.messageId),
        bigintPart(fields.messageId),
        bigintPart(fields.emojiId),
        JSON.stringify(fields.emojiName),
        bigintPart(fields.userId),
    ].join(SEPARATOR);
}

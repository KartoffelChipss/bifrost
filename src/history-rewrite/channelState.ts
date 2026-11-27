import { bigintPart, bigintValue, bucketOf } from '../fluxer-db/keys';
import type { Tx } from './fluxerWrites';

/**
 * Lowers channel_state.created_bucket to the oldest moved bucket. The API's
 * own listing (search reindex, exports) never scans below it
 * (MessageDataRepository.ts:152). A new message resets it, so the search
 * rebuild must run before anyone posts.
 */
export async function lowerCreatedBucket(
    tx: Tx,
    channelId: string,
    bucket: number
): Promise<void> {
    if (!Number.isSafeInteger(bucket) || bucket < 0) {
        throw new RangeError(`Bad bucket ${bucket}`);
    }
    await tx.run(
        `UPDATE fluxer_kv
         SET row_data = row_data || jsonb_build_object(
               'created_bucket', LEAST(COALESCE((row_data->>'created_bucket')::int, $2), $2),
               'has_messages', true),
             updated_at = now()
         WHERE table_name = 'channel_state' AND row_key = $1`,
        [bigintPart(channelId), bucket]
    );
}

/** The newest message ID left in a channel, or null when it has none. */
async function newestMessage(
    tx: Tx,
    channelId: string
): Promise<string | null> {
    const rows = await tx.rows<{ newest: string | null }>(
        `SELECT max(sort_id)::text AS newest FROM fluxer_kv
         WHERE table_name = 'messages' AND starts_with(partition_key, $1)`,
        [`${bigintPart(channelId)}\u001f`]
    );
    return rows[0]?.newest ?? null;
}

/**
 * When the channel's last message was a moved copy, points last_message_id
 * at the newest message left, in channel_state and in channels. Both only
 * move forward on their own (MessageDataRepository.ts:524,
 * ChannelDataRepository.ts:130-145), so a stale value would stay.
 */
export async function fixLastMessage(
    tx: Tx,
    channelId: string,
    movedIds: readonly string[]
): Promise<boolean> {
    const stale = await tx.rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM fluxer_kv
         WHERE table_name IN ('channel_state', 'channels')
           AND row_data->'channel_id'->>'value' = $1
           AND row_data->'last_message_id'->>'value' = ANY($2::text[])`,
        [channelId, movedIds]
    );
    if ((stale[0]?.n ?? 0) === 0) return false;
    const newest = await newestMessage(tx, channelId);
    if (newest === null) return false;
    await tx.run(
        `UPDATE fluxer_kv
         SET row_data = row_data || jsonb_build_object('last_message_id', $3::jsonb)
               || CASE WHEN table_name = 'channel_state'
                       THEN jsonb_build_object('last_message_bucket', $4::int)
                       ELSE '{}'::jsonb END,
             updated_at = now()
         WHERE table_name IN ('channel_state', 'channels')
           AND row_data->'channel_id'->>'value' = $1
           AND row_data->'last_message_id'->>'value' = ANY($2::text[])`,
        [
            channelId,
            movedIds,
            JSON.stringify(bigintValue(newest)),
            bucketOf(newest),
        ]
    );
    return true;
}

/**
 * Points replies at moved copies' new IDs, in any message of the channel.
 * Replies are looked up by (channel, message) (shard_impl.rs:1094-1117).
 */
export async function moveReplyReferences(
    tx: Tx,
    channelId: string,
    idMap: ReadonlyMap<string, string>
): Promise<void> {
    const pairs = [...idMap].map(([from, to]) => ({ from, to }));
    await tx.run(
        `UPDATE fluxer_kv kv
         SET row_data = jsonb_set(kv.row_data, '{message_reference,message_id}',
               jsonb_build_object('__fluxer_type', 'bigint', 'value', m.to)),
             updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS m("from" text, "to" text)
         WHERE kv.table_name = 'messages'
           AND kv.row_data->'channel_id'->>'value' = $1
           AND jsonb_typeof(kv.row_data->'message_reference') = 'object'
           AND kv.row_data->'message_reference'->'message_id'->>'value' = m."from"`,
        [channelId, JSON.stringify(pairs)]
    );
}

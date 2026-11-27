import {
    bigintPart,
    bigintValue,
    bucketOf,
    messagePartitionKey,
    reactionRowKey,
} from '../fluxer-db/keys';
import type { CopyPlan, KvRow } from './plan';

/** One statement inside the job's Fluxer transaction. */
export interface Tx {
    rows<T extends object>(sql: string, bind: readonly unknown[]): Promise<T[]>;
    run(sql: string, bind: readonly unknown[]): Promise<void>;
}

const SEPARATOR = '\u001f';

type Row = { row_key: string; row_data: Record<string, unknown> };

function idOf(value: unknown): string | null {
    const v = (value as { value?: unknown } | null)?.value;
    return typeof v === 'string' ? v : null;
}

/** Inserts rows; an existing key is left alone. */
export async function insertRows(
    tx: Tx,
    rows: readonly KvRow[]
): Promise<void> {
    if (rows.length === 0) return;
    const records = rows.map((r) => ({
        t: r.tableName,
        p: r.partitionKey,
        k: r.rowKey,
        d: r.rowData,
        s: r.sortId,
    }));
    await tx.run(
        `INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data, sort_id, updated_at)
         SELECT r.t, r.p, r.k, r.d, r.s::bigint, now()
         FROM jsonb_to_recordset($1::jsonb) AS r(t text, p text, k text, d jsonb, s text)
         ON CONFLICT (table_name, row_key) DO NOTHING`,
        [JSON.stringify(records)]
    );
}

async function deleteKeys(tx: Tx, table: string, keys: readonly string[]) {
    if (keys.length === 0) return;
    await tx.run(
        `DELETE FROM fluxer_kv WHERE table_name = $1 AND row_key = ANY($2::text[])`,
        [table, keys]
    );
}

/**
 * Checks the batch inside the transaction: every old row is still there
 * (and is locked), and no new key is taken. Throws otherwise.
 */
export async function guardBatch(tx: Tx, plans: readonly CopyPlan[]) {
    const oldKeys = plans.map((p) => p.oldRowKey);
    const found = await tx.rows<{ row_key: string }>(
        `SELECT row_key FROM fluxer_kv WHERE table_name = 'messages'
         AND row_key = ANY($1::text[]) FOR UPDATE`,
        [oldKeys]
    );
    if (found.length !== oldKeys.length) {
        throw new Error(
            `${oldKeys.length - found.length} old rows changed since planning`
        );
    }
    const taken = await tx.rows<{ row_key: string }>(
        `SELECT row_key FROM fluxer_kv WHERE table_name = 'messages'
         AND row_key = ANY($1::text[])`,
        [plans.map((p) => p.message.rowKey)]
    );
    if (taken.length > 0)
        throw new Error(`${taken.length} new message IDs are taken`);
}

/** Re-keys the reactions already on the moved copies (mirrored since import). */
export async function moveReactions(
    tx: Tx,
    channelId: string,
    idMap: ReadonlyMap<string, string>
): Promise<number> {
    const rows = await tx.rows<Row>(
        `SELECT row_key, row_data FROM fluxer_kv WHERE table_name = 'message_reactions'
         AND row_data->'channel_id'->>'value' = $1
         AND row_data->'message_id'->>'value' = ANY($2::text[])`,
        [channelId, [...idMap.keys()]]
    );
    const moved: KvRow[] = [];
    for (const row of rows) {
        const newId = idMap.get(idOf(row.row_data.message_id) ?? '');
        const emojiId = idOf(row.row_data.emoji_id);
        const userId = idOf(row.row_data.user_id);
        const name = row.row_data.emoji_name;
        if (!newId || !emojiId || !userId || typeof name !== 'string') continue;
        const fields = {
            channelId,
            messageId: newId,
            emojiId,
            emojiName: name,
            userId,
        };
        moved.push({
            tableName: 'message_reactions',
            partitionKey: messagePartitionKey(channelId, newId),
            rowKey: reactionRowKey(fields),
            rowData: {
                ...row.row_data,
                message_id: bigintValue(newId),
                bucket: bucketOf(newId),
            },
            sortId: newId,
        });
    }
    await insertRows(tx, moved);
    await deleteKeys(
        tx,
        'message_reactions',
        rows.map((r) => r.row_key)
    );
    return rows.length;
}

/** Re-keys pins of moved copies: (channel, pinned_timestamp, message). */
export async function movePins(
    tx: Tx,
    channelId: string,
    idMap: ReadonlyMap<string, string>
): Promise<number> {
    const rows = await tx.rows<Row & { partition_key: string }>(
        `SELECT partition_key, row_key, row_data FROM fluxer_kv WHERE table_name = 'channel_pins'
         AND row_data->'channel_id'->>'value' = $1
         AND row_data->'message_id'->>'value' = ANY($2::text[])`,
        [channelId, [...idMap.keys()]]
    );
    const moved: KvRow[] = [];
    for (const row of rows) {
        const newId = idMap.get(idOf(row.row_data.message_id) ?? '');
        if (!newId) continue;
        const cut = row.row_key.lastIndexOf(SEPARATOR);
        const rowKey = `${row.row_key.slice(0, cut + 1)}${bigintPart(newId)}`;
        moved.push({
            tableName: 'channel_pins',
            // No partition key is declared, so it equals the row key.
            partitionKey: rowKey,
            rowKey,
            rowData: { ...row.row_data, message_id: bigintValue(newId) },
            sortId: null,
        });
    }
    await insertRows(tx, moved);
    await deleteKeys(
        tx,
        'channel_pins',
        rows.map((r) => r.row_key)
    );
    return rows.length;
}

/** Points attachment lookups of moved copies at their new IDs. */
export async function moveAttachmentLookups(
    tx: Tx,
    channelId: string,
    idMap: ReadonlyMap<string, string>
): Promise<void> {
    const pairs = [...idMap].map(([from, to]) => ({ from, to }));
    await tx.run(
        `UPDATE fluxer_kv kv
         SET row_data = kv.row_data || jsonb_build_object('message_id',
               jsonb_build_object('__fluxer_type', 'bigint', 'value', m.to)),
             updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS m("from" text, "to" text)
         WHERE kv.table_name = 'attachment_lookup'
           AND kv.row_data->'channel_id'->>'value' = $1
           AND kv.row_data->'message_id'->>'value' = m."from"`,
        [channelId, JSON.stringify(pairs)]
    );
}

/** Adds the new buckets to the channel's index and clears empty markers. */
export async function indexBuckets(
    tx: Tx,
    channelId: string,
    buckets: readonly number[],
    now: Date
): Promise<void> {
    const partition = bigintPart(channelId);
    const rows: KvRow[] = [...new Set(buckets)].map((bucket) => ({
        tableName: 'channel_message_buckets',
        partitionKey: partition,
        rowKey: `${partition}${SEPARATOR}${bucket}`,
        rowData: {
            bucket,
            channel_id: bigintValue(channelId),
            updated_at: { __fluxer_type: 'date', value: now.toISOString() },
        },
        sortId: null,
    }));
    await insertRows(tx, rows);
    await deleteKeys(
        tx,
        'channel_empty_buckets',
        rows.map((r) => r.rowKey)
    );
}

/** Writes the moved copies and removes their old rows. */
export async function writeCopies(
    tx: Tx,
    plans: readonly CopyPlan[]
): Promise<void> {
    await insertRows(
        tx,
        plans.map((p) => p.message)
    );
    await insertRows(
        tx,
        plans.flatMap((p) => p.reactions)
    );
    await deleteKeys(
        tx,
        'messages',
        plans.map((p) => p.oldRowKey)
    );
}

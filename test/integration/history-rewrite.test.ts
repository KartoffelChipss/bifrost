import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataTypes, QueryTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import {
    bigintPart,
    bigintValue,
    bucketOf,
    messagePartitionKey,
    messageRowKey,
} from '../../src/fluxer-db/keys';
import { RewriteJob, type FluxerSide } from '../../src/history-rewrite/job';
import { BifrostSource } from '../../src/history-rewrite/sources';
import { createRecordingLogger } from '../addons/fakes';

/**
 * The rewrite job against Postgres: Fluxer's fluxer_kv table (layout and
 * trigger as on the live instance, 2026-11-27) and bifrost's own tables.
 */
const url = process.env.BF_TEST_POSTGRES_URL;
const FLUXER = 'bifrost_test_rewrite_fluxer';
const BIFROST = 'bifrost_test_rewrite_bifrost';

const CHANNEL = '1575322911084904448';
const THREAD = '1575346902172434432';
const WEBHOOK = '1575407231271174147';
const BOT = '1565044763378319360';
const GUILD_LINK = '00000000-0000-4000-8000-000000000001';
// Discord messages from 2019, and their 2026 Fluxer copies.
const D1 = '573091117793280000';
const D2 = '573091117793280001';
const F1 = '1575609360757817344';
const F2 = '1575609360757817345';
const F3 = '1575609360757817346';
const DATE = '*Originally posted 2019-05-01 10:19 UTC*';

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

async function freshDatabase(name: string): Promise<Sequelize> {
    const admin = new Sequelize(url ?? '', { logging: false });
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.close();
    return new Sequelize(databaseUrl(url ?? '', name), { logging: false });
}

async function createFluxerKv(db: Sequelize): Promise<void> {
    await db.query(`
        CREATE TABLE fluxer_kv (
            table_name text NOT NULL,
            partition_key text COLLATE "C" NOT NULL,
            row_key text COLLATE "C" NOT NULL,
            row_data jsonb NOT NULL,
            expires_at timestamptz,
            updated_at timestamptz NOT NULL DEFAULT now(),
            sort_id bigint,
            PRIMARY KEY (table_name, row_key)
        );
        CREATE FUNCTION fluxer_kv_sort_id_fill() RETURNS trigger AS $$
        BEGIN
            NEW.sort_id := (NEW.row_data->'message_id'->>'value')::bigint;
            RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER fluxer_kv_sort_id_fill BEFORE INSERT OR UPDATE ON fluxer_kv
        FOR EACH ROW WHEN (NEW.sort_id IS NULL AND NEW.table_name IN ('messages', 'message_reactions'))
        EXECUTE FUNCTION fluxer_kv_sort_id_fill();`);
}

async function kv(
    db: Sequelize,
    table: string,
    partition: string,
    key: string,
    data: object
) {
    await db.query(
        `INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data) VALUES ($1, $2, $3, $4::jsonb)`,
        { bind: [table, partition, key, JSON.stringify(data)] }
    );
}

function message(channel: string, id: string, fields: object = {}) {
    return {
        type: 0,
        flags: 0,
        bucket: bucketOf(id),
        version: 1,
        channel_id: bigintValue(channel),
        message_id: bigintValue(id),
        webhook_id: bigintValue(WEBHOOK),
        webhook_name: 'Jake',
        has_reaction: false,
        content: `hello\nReactions: 👍 2\n${DATE}`,
        ...fields,
    };
}

async function seedFluxer(db: Sequelize): Promise<void> {
    await db.query(`TRUNCATE fluxer_kv`);
    for (const [channel, id] of [
        [CHANNEL, F1],
        [CHANNEL, F2],
        [THREAD, F3],
    ] as const) {
        await kv(
            db,
            'messages',
            messagePartitionKey(channel, id),
            messageRowKey(channel, id),
            message(channel, id)
        );
    }
    await kv(db, 'thread_state', bigintPart(THREAD), bigintPart(THREAD), {
        thread_id: bigintValue(THREAD),
    });
    await kv(db, 'channel_state', bigintPart(CHANNEL), bigintPart(CHANNEL), {
        channel_id: bigintValue(CHANNEL),
        created_bucket: 434,
        last_message_id: bigintValue(F2),
        last_message_bucket: 434,
        has_messages: true,
    });
    const pinKey = [
        bigintPart(CHANNEL),
        JSON.stringify({
            __fluxer_type: 'date',
            value: '2026-11-26T18:15:10.978Z',
        }),
        bigintPart(F1),
    ].join('\u001f');
    await kv(db, 'channel_pins', pinKey, pinKey, {
        channel_id: bigintValue(CHANNEL),
        message_id: bigintValue(F1),
        pinned_timestamp: {
            __fluxer_type: 'date',
            value: '2026-11-26T18:15:10.978Z',
        },
    });
    await kv(db, 'attachment_lookup', 'a', 'a', {
        channel_id: bigintValue(CHANNEL),
        message_id: bigintValue(F2),
        attachment_id: bigintValue('1'),
        filename: 'x.png',
    });
}

async function seedBifrost(db: Sequelize): Promise<void> {
    await db.query(
        `TRUNCATE ${TABLES.historyMessages}, ${TABLES.historyJobs}, ${TABLES.archiveMessages} CASCADE`
    );
    await db.query(
        `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", status, "createdAt", "updatedAt")
         VALUES ('00000000-0000-4000-8000-000000000002', $1, 'channel', '200', 'done', now(), now())`,
        { bind: [GUILD_LINK] }
    );
    const copies = [
        [D1, F1, CHANNEL],
        [D2, F2, CHANNEL],
        ['573091117793280002', F3, THREAD],
    ];
    for (const [discord, fluxer, target] of copies) {
        await db.query(
            `INSERT INTO ${TABLES.historyMessages} ("discordMessageId", "jobId", "discordAuthorId", "fluxerMessageId", "fluxerTargetId", "inThread", "webhookId", "createdAt")
             VALUES ($1, '00000000-0000-4000-8000-000000000002', '500', $2, $3, false, $4, now())`,
            { bind: [discord, fluxer, target, WEBHOOK] }
        );
    }
    const raw = {
        type: 19,
        message_reference: { message_id: D1 },
        edited_timestamp: '2019-05-01T11:00:00+00:00',
        reactions: [{ emoji: { id: null, name: '👍' }, count: 2 }],
    };
    await db.query(
        `INSERT INTO ${TABLES.archiveMessages} ("messageId", "channelId", "guildId", "authorId", "createdAt", raw, redacted, "fetchedAt")
         VALUES ($1, '200', '100', '500', now(), $2::jsonb, false, now())`,
        { bind: [D2, JSON.stringify(raw)] }
    );
}

function fluxerSide(db: Sequelize): FluxerSide {
    return {
        threadIds: async () => {
            const rows = await db.query<{ id: string }>(
                `SELECT row_data->'thread_id'->>'value' AS id FROM fluxer_kv WHERE table_name = 'thread_state'`,
                { type: QueryTypes.SELECT }
            );
            return new Set(rows.map((r) => r.id));
        },
        messageRows: async (keys) => {
            const rows = await db.query<{
                row_key: string;
                row_data: Record<string, unknown>;
            }>(
                `SELECT row_key, row_data FROM fluxer_kv WHERE table_name = 'messages' AND row_key = ANY($1::text[])`,
                { bind: [[...keys]], type: QueryTypes.SELECT }
            );
            return new Map(rows.map((r) => [r.row_key, r.row_data]));
        },
        transaction: (work) =>
            db.transaction((t) =>
                work({
                    rows: <T extends object>(
                        sql: string,
                        bind: readonly unknown[]
                    ) =>
                        db.query<T>(sql, {
                            bind: [...bind],
                            type: QueryTypes.SELECT,
                            transaction: t,
                        }),
                    run: async (sql, bind) => {
                        await db.query(sql, {
                            bind: [...bind],
                            transaction: t,
                        });
                    },
                })
            ),
    };
}

async function one<T extends object>(
    db: Sequelize,
    sql: string,
    bind: unknown[] = []
): Promise<T> {
    const rows = await db.query<T>(sql, { bind, type: QueryTypes.SELECT });
    assert.ok(rows[0], `no row for ${sql}`);
    return rows[0];
}

describe('history rewrite on Postgres', { skip: !url }, () => {
    let fluxer: Sequelize;
    let bifrost: Sequelize;

    before(async () => {
        fluxer = await freshDatabase(FLUXER);
        await createFluxerKv(fluxer);
        bifrost = await freshDatabase(BIFROST);
        const qi = bifrost.getQueryInterface();
        await qi.createTable('guild_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        await qi.createTable('channel_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            guildLinkId: { type: DataTypes.UUID },
            fluxerChannelId: { type: DataTypes.STRING },
            fluxerWebhookId: { type: DataTypes.STRING },
            fluxerWebhookToken: { type: DataTypes.STRING },
        });
        await qi.createTable('message_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            guildLinkId: { type: DataTypes.UUID },
            channelLinkId: { type: DataTypes.UUID },
            discordMessageId: { type: DataTypes.STRING },
            fluxerMessageId: { type: DataTypes.STRING },
        });
        await bifrost.query(
            `INSERT INTO guild_links (id, "createdAt") VALUES ($1, now())`,
            { bind: [GUILD_LINK] }
        );
        await runAddonMigrations(bifrost, createRecordingLogger());
    });

    beforeEach(async () => {
        await seedFluxer(fluxer);
        await seedBifrost(bifrost);
    });

    after(async () => {
        await fluxer.close();
        await bifrost.close();
    });

    const job = (apply: boolean) =>
        new RewriteJob({
            bifrost: new BifrostSource(bifrost),
            fluxer: fluxerSide(fluxer),
            botUserId: BOT,
            apply,
            log: () => {},
            now: () => new Date('2026-11-27T12:00:00Z'),
        });

    it('plans without writing in a dry run', async () => {
        const report = await job(false).run();
        assert.equal(report.planned, 2);
        assert.equal(report.written, 0);
        assert.equal(report.copiesInThreadsSkipped, 1);
        const left = await one<{ n: number }>(
            fluxer,
            `SELECT count(*)::int AS n FROM fluxer_kv WHERE row_key = $1`,
            [messageRowKey(CHANNEL, F1)]
        );
        assert.equal(left.n, 1);
    });

    it('moves channel copies and everything that points at them', async () => {
        const report = await job(true).run();
        assert.deepEqual(
            [
                report.written,
                report.nativeReplies,
                report.edited,
                report.reactions,
            ],
            [2, 1, 1, 1]
        );

        const moved = await one<{
            row_data: Record<string, unknown>;
            sort_id: string;
        }>(
            fluxer,
            `SELECT row_data, sort_id::text FROM fluxer_kv WHERE table_name = 'messages' AND row_key = $1`,
            [messageRowKey(CHANNEL, D2)]
        );
        assert.equal(moved.sort_id, D2);
        assert.equal(moved.row_data.content, 'hello');
        assert.deepEqual(
            (moved.row_data.message_reference as { message_id: unknown })
                .message_id,
            bigintValue(D1)
        );
        const gone = await one<{ n: number }>(
            fluxer,
            `SELECT count(*)::int AS n FROM fluxer_kv WHERE table_name = 'messages' AND row_key = ANY($1::text[])`,
            [[messageRowKey(CHANNEL, F1), messageRowKey(CHANNEL, F2)]]
        );
        assert.equal(gone.n, 0);
        const thread = await one<{ n: number }>(
            fluxer,
            `SELECT count(*)::int AS n FROM fluxer_kv WHERE row_key = $1`,
            [messageRowKey(THREAD, F3)]
        );
        assert.equal(thread.n, 1);

        const reaction = await one<{ sort_id: string }>(
            fluxer,
            `SELECT sort_id::text FROM fluxer_kv WHERE table_name = 'message_reactions'`
        );
        assert.equal(reaction.sort_id, D2);
        const pin = await one<{ id: string }>(
            fluxer,
            `SELECT row_data->'message_id'->>'value' AS id FROM fluxer_kv WHERE table_name = 'channel_pins'`
        );
        assert.equal(pin.id, D1);
        const lookup = await one<{ id: string }>(
            fluxer,
            `SELECT row_data->'message_id'->>'value' AS id FROM fluxer_kv WHERE table_name = 'attachment_lookup'`
        );
        assert.equal(lookup.id, D2);
        const bucket = await one<{ n: number }>(
            fluxer,
            `SELECT count(*)::int AS n FROM fluxer_kv WHERE table_name = 'channel_message_buckets' AND row_key = $1`,
            [`${bigintPart(CHANNEL)}\u001f${bucketOf(D1)}`]
        );
        assert.equal(bucket.n, 1);
        const state = await one<{ created: number; last: string }>(
            fluxer,
            `SELECT (row_data->>'created_bucket')::int AS created, row_data->'last_message_id'->>'value' AS last FROM fluxer_kv WHERE table_name = 'channel_state'`
        );
        assert.deepEqual([state.created, state.last], [bucketOf(D1), D2]);

        const rows = await bifrost.query<{
            fluxerMessageId: string;
            formerFluxerMessageId: string;
            native: boolean;
            nativeReply: boolean;
        }>(
            `SELECT "fluxerMessageId", "formerFluxerMessageId", native, "nativeReply" FROM ${TABLES.historyMessages} WHERE "fluxerTargetId" = $1 ORDER BY "discordMessageId"`,
            { bind: [CHANNEL], type: QueryTypes.SELECT }
        );
        assert.deepEqual(rows, [
            {
                fluxerMessageId: D1,
                formerFluxerMessageId: F1,
                native: true,
                nativeReply: false,
            },
            {
                fluxerMessageId: D2,
                formerFluxerMessageId: F2,
                native: true,
                nativeReply: true,
            },
        ]);
    });

    it('does nothing more on a second run', async () => {
        await job(true).run();
        const again = await job(true).run();
        assert.equal(again.written, 0);
        assert.equal(again.planned, 0);
    });

    it('records copies a stopped run already moved', async () => {
        await job(true).run();
        await bifrost.query(
            `UPDATE ${TABLES.historyMessages} SET native = false, "fluxerMessageId" = "formerFluxerMessageId" WHERE "fluxerTargetId" = $1`,
            { bind: [CHANNEL] }
        );
        const report = await job(true).run();
        assert.equal(report.recovered, 2);
        const left = await one<{ n: number }>(
            bifrost,
            `SELECT count(*)::int AS n FROM ${TABLES.historyMessages} WHERE NOT native AND "fluxerTargetId" = $1`,
            [CHANNEL]
        );
        assert.equal(left.n, 0);
    });
});

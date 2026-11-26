import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { PostgresHistoryStore } from '../../src/history/store';
import { createRecordingLogger } from '../addons/fakes';

/** History store queries added with migration 00007, on real Postgres. */
const url = process.env.BF_TEST_POSTGRES_URL;
const DATABASE = 'bifrost_test_history_store';

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

describe('PostgresHistoryStore readiness and retry', { skip: !url }, () => {
    let db: Sequelize;
    let linkId: string;

    const job = (discordId: string, status: string, extra = '') =>
        db.query(
            `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", status, "createdAt", "updatedAt"${extra ? ', "archiveThreadId"' : ''})
             VALUES ($1, $2, 'channel', $3, $4, now(), now()${extra ? ', $5' : ''})`,
            {
                bind: extra
                    ? [randomUUID(), linkId, discordId, status, extra]
                    : [randomUUID(), linkId, discordId, status],
            }
        );

    before(async () => {
        const admin = new Sequelize(url ?? '', { logging: false });
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await admin.query(`CREATE DATABASE ${DATABASE}`);
        await admin.close();
        db = new Sequelize(databaseUrl(url ?? '', DATABASE), {
            logging: false,
        });
        await db.getQueryInterface().createTable('guild_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        await runAddonMigrations(db, createRecordingLogger());
        linkId = randomUUID();
        await db.query(
            `INSERT INTO guild_links (id, "createdAt") VALUES ($1, now())`,
            { bind: [linkId] }
        );
        await job('ready', 'ready');
        await job('done', 'done');
        await job('failed', 'failed');
        await job('importing', 'importing');
        await job('archived', 'importing', 'f-archive');
    });

    after(() => db.close());

    it('bridges completed and archive-mode channels, never failed ones', async () => {
        const store = new PostgresHistoryStore(db);
        const ready = await store.channelsReadyToBridge(linkId);
        assert.deepEqual([...ready].sort(), ['archived', 'done', 'ready']);
    });

    it('lists open jobs and key columns, and tells a waiting link', async () => {
        const store = new PostgresHistoryStore(db);
        const open = await store.listOpenJobs(linkId);
        assert.deepEqual(open.map((j) => j.discordId).sort(), [
            'archived',
            'importing',
            'ready',
        ]);
        const keys = await store.jobKeys(linkId);
        assert.equal(keys.length, 5);
        assert.deepEqual(Object.keys(keys[0] ?? {}).sort(), [
            'discordId',
            'fluxerId',
            'id',
            'kind',
        ]);
        // The ready channel waits for its bridge.
        assert.equal(await store.hasWaitingJob(linkId, new Date()), true);
        assert.equal(
            await store.hasWaitingJob(randomUUID(), new Date()),
            false
        );
    });

    it('lists past the old limit of 10,000 jobs and sums jobs in SQL', async () => {
        const store = new PostgresHistoryStore(db);
        const big = randomUUID();
        await db.query(
            `INSERT INTO guild_links (id, "createdAt") VALUES ($1, now())`,
            { bind: [big] }
        );
        await db.query(
            `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", status, imported, skipped, "createdAt", "updatedAt")
             SELECT gen_random_uuid(), $1, 'thread', 't' || g, 'done', 2, 1, now(), now()
             FROM generate_series(1, 10001) AS g`,
            { bind: [big] }
        );
        assert.equal((await store.listJobs(big)).length, 10_001);
        assert.equal((await store.jobKeys(big)).length, 10_001);
        assert.deepEqual(await store.listOpenJobs(big), []);
        assert.deepEqual(await store.jobTotals(big), {
            jobs: 10_001,
            open: 0,
            imported: 20_002,
            skipped: 10_001,
            failed: 0,
        });
        assert.equal(await store.hasWaitingJob(big, new Date()), false);
    });

    it('knows its archive threads', async () => {
        const store = new PostgresHistoryStore(db);
        assert.equal(await store.isArchiveThread('f-archive'), true);
        assert.equal(await store.isArchiveThread('other'), false);
    });

    it('puts failed jobs back to work with a fresh skip streak', async () => {
        const store = new PostgresHistoryStore(db);
        await db.query(
            `UPDATE ${TABLES.historyJobs} SET "skipStreak" = 7 WHERE "discordId" = 'failed'`
        );
        assert.equal(await store.retryFailed(linkId, new Date()), 1);
        const [retried] = (await store.listJobs(linkId)).filter(
            (j) => j.discordId === 'failed'
        );
        assert.equal(retried?.skipStreak, 0);
        const ready = await store.channelsReadyToBridge(linkId);
        assert.equal(ready.has('failed'), false);
        assert.equal(await store.retryFailed(linkId, new Date()), 0);
    });
});

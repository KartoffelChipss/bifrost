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

    it('knows its archive threads', async () => {
        const store = new PostgresHistoryStore(db);
        assert.equal(await store.isArchiveThread('f-archive'), true);
        assert.equal(await store.isArchiveThread('other'), false);
    });

    it('puts failed jobs back to work', async () => {
        const store = new PostgresHistoryStore(db);
        assert.equal(await store.retryFailed(linkId, new Date()), 1);
        const ready = await store.channelsReadyToBridge(linkId);
        assert.equal(ready.has('failed'), false);
        assert.equal(await store.retryFailed(linkId, new Date()), 0);
    });
});

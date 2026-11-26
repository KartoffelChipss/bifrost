import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { PostgresFailureCountStore } from '../../src/guild-sync/failureStore';
import { createRecordingLogger } from '../addons/fakes';

/** Failure counts (migration 00014) on real Postgres. */
const url = process.env.BF_TEST_POSTGRES_URL;
const DATABASE = 'bifrost_test_failure_counts';

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

describe('failure counts on Postgres', { skip: !url }, () => {
    let db: Sequelize;
    let store: PostgresFailureCountStore;

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
        store = new PostgresFailureCountStore(db);
    });

    after(async () => {
        await db.close();
    });

    it('saves, updates, reads back and clears a count', async () => {
        await store.saveFailureCount('create:thread:a', 1, new Date());
        await store.saveFailureCount('create:thread:a', 4, new Date());
        await store.saveFailureCount('create:thread:b', 2, new Date());
        const rows = await store.loadFailureCounts(10);
        assert.deepEqual(
            [...rows].sort((x, y) => x.key.localeCompare(y.key)),
            [
                { key: 'create:thread:a', count: 4 },
                { key: 'create:thread:b', count: 2 },
            ]
        );
        await store.clearFailureCount('create:thread:a');
        assert.deepEqual(await store.loadFailureCounts(10), [
            { key: 'create:thread:b', count: 2 },
        ]);
    });

    it('forgets counts older than a week when reading', async () => {
        await db.query(`DELETE FROM ${TABLES.failureCounts}`);
        const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
        await store.saveFailureCount('create:role:old', 3, old);
        await store.saveFailureCount('create:role:new', 3, new Date());
        assert.deepEqual(await store.loadFailureCounts(10), [
            { key: 'create:role:new', count: 3 },
        ]);
    });
});

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import {
    PostgresParkedMessages,
    type ParkedMessage,
} from '../../src/guild-sync/parkedMessages';
import { createRecordingLogger } from '../addons/fakes';

/**
 * Runs the parked-message store against a real Postgres
 * (BF_TEST_POSTGRES_URL), in its own database.
 */
const url = process.env.BF_TEST_POSTGRES_URL;
const DATABASE = 'bifrost_test_parked';

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

const parked = (
    messageId: string,
    over: Partial<ParkedMessage> = {}
): ParkedMessage => ({
    from: 'discord',
    messageId,
    threadId: 't1',
    parentId: 'p1',
    webhookId: null,
    parkedAt: 1_000,
    ...over,
});

describe('PostgresParkedMessages', { skip: !url }, () => {
    let db: Sequelize;

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
    });

    after(() => db.close());

    it('keeps messages per thread in order and drops them', async () => {
        const store = new PostgresParkedMessages(db);
        await store.park(parked('m1'));
        await store.park(parked('m2', { webhookId: 'w' }));
        await store.park(parked('m1'));
        await store.park(parked('f1', { from: 'fluxer', threadId: 't2' }));
        assert.equal(await store.waiting('discord', 't1'), true);
        assert.equal(await store.waiting('fluxer', 't1'), false);
        const list = await store.list('discord', 't1', 10);
        assert.deepEqual(
            list.map((m) => [m.messageId, m.webhookId, m.parkedAt]),
            [
                ['m1', null, 1_000],
                ['m2', 'w', 1_000],
            ]
        );
        assert.deepEqual(await store.threads(10), [
            { from: 'discord', threadId: 't1' },
            { from: 'fluxer', threadId: 't2' },
        ]);
        assert.equal(await store.failed('discord', 'm1'), 1);
        assert.equal(await store.failed('discord', 'm1'), 2);
        assert.equal(await store.remove('discord', 'm1'), true);
        assert.equal(await store.remove('discord', 'm1'), false);
        await store.expire(2_000);
        assert.deepEqual(await store.threads(10), []);
    });

    it('keeps only the newest messages above the limit', async () => {
        const store = new PostgresParkedMessages(db, 2);
        for (const id of ['a', 'b', 'c']) await store.park(parked(id));
        const list = await store.list('discord', 't1', 10);
        assert.deepEqual(
            list.map((m) => m.messageId),
            ['b', 'c']
        );
    });
});

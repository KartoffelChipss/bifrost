import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { PostgresHistoryPairs } from '../../src/relay-extras/historyPairs';
import { createRecordingLogger } from '../addons/fakes';

/**
 * Reads imported history pairs from a real Postgres (BF_TEST_POSTGRES_URL),
 * in its own database.
 */
const url = process.env.BF_TEST_POSTGRES_URL;
const DATABASE = 'bifrost_test_history_pairs';

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

describe('PostgresHistoryPairs', { skip: !url }, () => {
    let db: Sequelize;
    let linkId: string;

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
        const jobId = randomUUID();
        await db.query(
            `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", status, "createdAt", "updatedAt")
             VALUES ($1, $2, 'thread', 'd-thread', 'done', now(), now())`,
            { bind: [jobId, linkId] }
        );
        await db.query(
            `INSERT INTO ${TABLES.historyMessages} ("discordMessageId", "jobId", "discordAuthorId", "fluxerMessageId", "fluxerTargetId", "inThread", "webhookId", "createdAt")
             VALUES ('d-past', $1, 'author', 'f-past', 'f-thread', true, 'w', now()),
                    ('d-unfinished', $1, 'author', NULL, 'f-thread', true, 'w', now())`,
            { bind: [jobId] }
        );
    });

    after(() => db.close());

    it('finds an imported pair by either message ID', async () => {
        const pairs = new PostgresHistoryPairs(db);
        const expected = {
            guildLinkId: linkId,
            discord: { channelId: 'd-thread', messageId: 'd-past' },
            fluxer: { channelId: 'f-thread', messageId: 'f-past' },
        };
        assert.deepEqual(
            await pairs.historyMessage('discord', 'd-past'),
            expected
        );
        assert.deepEqual(
            await pairs.historyMessage('fluxer', 'f-past'),
            expected
        );
    });

    it('returns null for unknown and unfinished copies', async () => {
        const pairs = new PostgresHistoryPairs(db);
        assert.equal(await pairs.historyMessage('discord', 'nope'), null);
        assert.equal(
            await pairs.historyMessage('discord', 'd-unfinished'),
            null
        );
    });
});

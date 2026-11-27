import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import { SequelizeStorage } from 'umzug';
import {
    createAddonUmzug,
    runAddonMigrations,
} from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { createRecordingLogger } from '../addons/fakes';

/**
 * Runs the add-on migrations against a real Postgres. Set
 * BF_TEST_POSTGRES_URL to a throwaway database; the test drops and recreates
 * its public schema. Skipped when the variable is unset.
 */
const url = process.env.BF_TEST_POSTGRES_URL;
const MIGRATIONS = [
    '00001-addon-baseline',
    '00002-object-map-applied-fields',
    '00003-settings-admin-approval',
    '00004-threads',
    '00005-history-identity',
    '00006-parked-messages',
    '00007-history-resilience',
    '00008-settings-enforce-drift',
    '00009-history-skip-streak',
    '00010-history-failure-tracking',
    '00011-settings-status-message',
    '00012-object-map-dest-missing',
    '00013-history-mentions',
    '00014-failure-counts',
    '00015-discord-archive',
    '00016-native-history',
];

describe('add-on tables on Postgres', { skip: !url }, () => {
    let db: Sequelize;
    let guildLinkId: string;

    before(async () => {
        db = new Sequelize(url ?? '', { logging: false });
        await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        // The upstream table the add-on tables reference.
        await db.getQueryInterface().createTable('guild_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            discordGuildId: { type: DataTypes.STRING },
            fluxerGuildId: { type: DataTypes.STRING },
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        // Upstream's migrator registers its storage model on the same
        // instance at startup (src/db/migrator.ts). Mirror that here.
        await new SequelizeStorage({ sequelize: db }).executed();
        guildLinkId = randomUUID();
        await db.query(
            `INSERT INTO guild_links (id, "discordGuildId", "fluxerGuildId", "createdAt") VALUES ($1, 'd', 'f', now())`,
            { bind: [guildLinkId] }
        );
    });

    after(() => db.close());

    it('applies the baseline once', async () => {
        const logger = createRecordingLogger();
        assert.deepEqual(await runAddonMigrations(db, logger), MIGRATIONS);
        assert.deepEqual(await runAddonMigrations(db, logger), []);
        const tables = await db.getQueryInterface().showAllTables();
        for (const table of Object.values(TABLES)) {
            assert.ok(tables.includes(table), `${table} exists`);
        }
    });

    it('records add-on migrations apart from upstream', async () => {
        const [addon] = await db.query(
            'SELECT name FROM addon_migrations ORDER BY name'
        );
        const [upstream] = await db.query('SELECT name FROM "SequelizeMeta"');
        assert.deepEqual(
            addon,
            MIGRATIONS.map((name) => ({ name }))
        );
        assert.deepEqual(upstream, []);
    });

    it('fills settings defaults from the design', async () => {
        await db.query(
            `INSERT INTO ${TABLES.settings} ("guildLinkId", "updatedAt") VALUES ($1, now())`,
            { bind: [guildLinkId] }
        );
        const [rows] = await db.query(
            `SELECT mode, direction, "killSwitch", "deleteBudgetPerCycle", "deleteBudgetPerDay", "gracePeriodDays", "writeCapPerCycle" FROM ${TABLES.settings}`
        );
        assert.deepEqual(rows, [
            {
                mode: 'dry-run',
                direction: 'discord-to-fluxer',
                killSwitch: false,
                deleteBudgetPerCycle: 3,
                deleteBudgetPerDay: 10,
                gracePeriodDays: 14,
                writeCapPerCycle: 50,
            },
        ]);
    });

    it('starts settings with no status message', async () => {
        const [rows] = await db.query(
            `SELECT "statusChannelId", "statusMessageId" FROM ${TABLES.settings} WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId] }
        );
        assert.deepEqual(rows, [
            { statusChannelId: null, statusMessageId: null },
        ]);
    });

    it('rejects values outside the allowed lists', async () => {
        await assert.rejects(
            db.query(
                `UPDATE ${TABLES.settings} SET mode = 'yolo' WHERE "guildLinkId" = $1`,
                { bind: [guildLinkId] }
            )
        );
        await assert.rejects(
            db.query(
                `UPDATE ${TABLES.settings} SET "writeCapPerCycle" = 0 WHERE "guildLinkId" = $1`,
                { bind: [guildLinkId] }
            )
        );
        await assert.rejects(insertMapping('webhook', 'd1', 'f1'));
        await assert.rejects(insertMapping('role', null, null));
    });

    it('starts mappings with no destination absence counted', async () => {
        const id = randomUUID();
        await db.query(
            `INSERT INTO ${TABLES.objectMap} (id, "guildLinkId", kind, "discordId", "fluxerId", "createdBySync", "createdAt", "updatedAt") VALUES ($1, $2, 'emoji', 'de', 'fe', true, now(), now())`,
            { bind: [id, guildLinkId] }
        );
        const [rows] = await db.query(
            `SELECT "destMissingCount", "destMissingSince" FROM ${TABLES.objectMap} WHERE id = $1`,
            { bind: [id] }
        );
        assert.deepEqual(rows, [
            { destMissingCount: 0, destMissingSince: null },
        ]);
        await assert.rejects(
            db.query(
                `UPDATE ${TABLES.objectMap} SET "destMissingCount" = -1 WHERE id = $1`,
                { bind: [id] }
            )
        );
    });

    it('keeps one mapping per source and per destination object', async () => {
        await insertMapping('role', 'd2', 'f2');
        await assert.rejects(insertMapping('role', 'd2', 'f3'));
        await assert.rejects(insertMapping('role', 'd3', 'f2'));
        await insertMapping('channel', 'd2', 'f2');
    });

    it('drops mappings and settings when the guild link is removed', async () => {
        await db.query('DELETE FROM guild_links WHERE id = $1', {
            bind: [guildLinkId],
        });
        const [[map], [settings]] = await Promise.all([
            db.query(`SELECT count(*)::int AS n FROM ${TABLES.objectMap}`),
            db.query(`SELECT count(*)::int AS n FROM ${TABLES.settings}`),
        ]);
        assert.deepEqual([map, settings], [[{ n: 0 }], [{ n: 0 }]]);
    });

    it('reverts cleanly', async () => {
        await createAddonUmzug(db).down({ to: 0 });
        const tables = await db.getQueryInterface().showAllTables();
        for (const table of Object.values(TABLES)) {
            assert.ok(!tables.includes(table), `${table} dropped`);
        }
    });

    function insertMapping(
        kind: string,
        discordId: string | null,
        fluxerId: string | null
    ) {
        return db.query(
            `INSERT INTO ${TABLES.objectMap} (id, "guildLinkId", kind, "discordId", "fluxerId", "createdBySync", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, true, now(), now())`,
            { bind: [randomUUID(), guildLinkId, kind, discordId, fluxerId] }
        );
    }
});

describe('add-on baseline after a failure', { skip: !url }, () => {
    let db: Sequelize;

    before(async () => {
        db = new Sequelize(url ?? '', { logging: false });
        await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        await db.getQueryInterface().createTable('guild_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        // A table in the way of the last create makes the baseline fail late.
        await db.query(`CREATE TABLE ${TABLES.leaderLock} (x int)`);
    });

    after(() => db.close());

    it('rolls back every table and records nothing', async () => {
        await assert.rejects(runAddonMigrations(db, createRecordingLogger()));
        const tables = await db.getQueryInterface().showAllTables();
        assert.ok(!tables.includes(TABLES.objectMap));
        const [applied] = await db.query('SELECT name FROM addon_migrations');
        assert.deepEqual(applied, []);
    });

    it('applies cleanly on the next start', async () => {
        await db.query(`DROP TABLE ${TABLES.leaderLock}`);
        assert.deepEqual(
            await runAddonMigrations(db, createRecordingLogger()),
            MIGRATIONS
        );
    });
});

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { Sequelize } from 'sequelize';
import type { AddonConfig } from '../../src/addons/config';
import {
    AddonDatabaseError,
    initAddonDatabase,
    runAddonMigrations,
} from '../../src/addons/db/migrator';
import { createRecordingLogger } from './fakes';

const OFF: AddonConfig = {
    enabled: false,
    guildSync: false,
    history: false,
    identity: false,
    initialMode: 'dry-run',
    allowApply: false,
    excludedChannels: new Set(),
    warnings: [],
};

describe('add-on migrations on SQLite', () => {
    const sqlite = new Sequelize('sqlite::memory:', { logging: false });
    after(() => sqlite.close());

    it('refuses to run', async () => {
        await assert.rejects(
            runAddonMigrations(sqlite, createRecordingLogger()),
            AddonDatabaseError
        );
    });

    it('does nothing while add-ons are off', async () => {
        const state = await initAddonDatabase(
            OFF,
            sqlite,
            createRecordingLogger()
        );
        assert.equal(state, 'off');
        const tables = await sqlite.getQueryInterface().showAllTables();
        assert.deepEqual(tables, []);
    });

    it('reports a failed migration instead of throwing', async () => {
        const logger = createRecordingLogger();
        const state = await initAddonDatabase(
            { ...OFF, enabled: true },
            sqlite,
            logger
        );
        assert.equal(state, 'failed');
        const errors = logger.entries.filter((e) => e.level === 'error');
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /relay keeps running/);
        assert.ok(errors[0].meta[0] instanceof AddonDatabaseError);
    });
});

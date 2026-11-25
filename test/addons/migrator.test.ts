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
        await initAddonDatabase(OFF, sqlite, createRecordingLogger());
        const tables = await sqlite.getQueryInterface().showAllTables();
        assert.deepEqual(tables, []);
    });
});

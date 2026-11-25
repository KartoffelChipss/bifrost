import type { QueryInterface, Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug, type RunnableMigration } from 'umzug';
import type { AddonConfig } from '../config';
import type { AddonLogger } from '../isolation';
import * as baseline from './migrations/00001-addon-baseline';
import * as appliedFields from './migrations/00002-object-map-applied-fields';
import * as adminApproval from './migrations/00003-settings-admin-approval';
import * as threads from './migrations/00004-threads';
import { MIGRATIONS_MODEL, MIGRATIONS_TABLE } from './schema';

/**
 * Add-on migrations, listed explicitly in order. Upstream's migrations stay
 * in `src/db/migrations` and its own Umzug storage; these run after them
 * with a separate storage table, so the two never interleave.
 */
const MIGRATIONS: RunnableMigration<QueryInterface>[] = [
    { name: '00001-addon-baseline', up: baseline.up, down: baseline.down },
    {
        name: '00002-object-map-applied-fields',
        up: appliedFields.up,
        down: appliedFields.down,
    },
    {
        name: '00003-settings-admin-approval',
        up: adminApproval.up,
        down: adminApproval.down,
    },
    { name: '00004-threads', up: threads.up, down: threads.down },
];

export class AddonDatabaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AddonDatabaseError';
    }
}

export function createAddonUmzug(sequelize: Sequelize) {
    return new Umzug({
        migrations: MIGRATIONS,
        context: sequelize.getQueryInterface(),
        // Umzug reuses any model already registered under modelName, and
        // upstream registers the default 'SequelizeMeta' first. A distinct
        // name keeps add-on records out of upstream's table.
        storage: new SequelizeStorage({
            sequelize,
            modelName: MIGRATIONS_MODEL,
            tableName: MIGRATIONS_TABLE,
        }),
        logger: undefined,
    });
}

/** Applies pending add-on migrations. Returns the names it applied. */
export async function runAddonMigrations(
    sequelize: Sequelize,
    logger: AddonLogger
): Promise<string[]> {
    const dialect = sequelize.getDialect();
    if (dialect !== 'postgres') {
        throw new AddonDatabaseError(
            `Add-on tables need Postgres, but the database is ${dialect}`
        );
    }
    const applied = await createAddonUmzug(sequelize).up();
    const names = applied.map((migration) => migration.name);
    if (names.length > 0) {
        logger.info(`[addons] Applied migrations: ${names.join(', ')}`);
    }
    return names;
}

/**
 * Prepares the add-on tables at startup. Does nothing when add-ons are off,
 * so a plain Bifröst install never gets them.
 */
export async function initAddonDatabase(
    config: AddonConfig,
    sequelize: Sequelize,
    logger: AddonLogger
): Promise<void> {
    if (!config.enabled) return;
    await runAddonMigrations(sequelize, logger);
}

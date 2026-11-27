import type { QueryInterface, Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug, type RunnableMigration } from 'umzug';
import type { AddonConfig } from '../config';
import type { AddonLogger } from '../isolation';
import * as baseline from './migrations/00001-addon-baseline';
import * as appliedFields from './migrations/00002-object-map-applied-fields';
import * as adminApproval from './migrations/00003-settings-admin-approval';
import * as threads from './migrations/00004-threads';
import * as historyIdentity from './migrations/00005-history-identity';
import * as parkedMessages from './migrations/00006-parked-messages';
import * as historyResilience from './migrations/00007-history-resilience';
import * as enforceDrift from './migrations/00008-settings-enforce-drift';
import * as historySkipStreak from './migrations/00009-history-skip-streak';
import * as historyFailureTracking from './migrations/00010-history-failure-tracking';
import * as statusMessage from './migrations/00011-settings-status-message';
import * as destMissing from './migrations/00012-object-map-dest-missing';
import * as historyMentions from './migrations/00013-history-mentions';
import * as failureCounts from './migrations/00014-failure-counts';
import * as discordArchive from './migrations/00015-discord-archive';
import * as nativeHistory from './migrations/00016-native-history';
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
    {
        name: '00005-history-identity',
        up: historyIdentity.up,
        down: historyIdentity.down,
    },
    {
        name: '00006-parked-messages',
        up: parkedMessages.up,
        down: parkedMessages.down,
    },
    {
        name: '00007-history-resilience',
        up: historyResilience.up,
        down: historyResilience.down,
    },
    {
        name: '00008-settings-enforce-drift',
        up: enforceDrift.up,
        down: enforceDrift.down,
    },
    {
        name: '00009-history-skip-streak',
        up: historySkipStreak.up,
        down: historySkipStreak.down,
    },
    {
        name: '00010-history-failure-tracking',
        up: historyFailureTracking.up,
        down: historyFailureTracking.down,
    },
    {
        name: '00011-settings-status-message',
        up: statusMessage.up,
        down: statusMessage.down,
    },
    {
        name: '00012-object-map-dest-missing',
        up: destMissing.up,
        down: destMissing.down,
    },
    {
        name: '00013-history-mentions',
        up: historyMentions.up,
        down: historyMentions.down,
    },
    {
        name: '00014-failure-counts',
        up: failureCounts.up,
        down: failureCounts.down,
    },
    {
        name: '00015-discord-archive',
        up: discordArchive.up,
        down: discordArchive.down,
    },
    {
        name: '00016-native-history',
        up: nativeHistory.up,
        down: nativeHistory.down,
    },
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

/** Whether the add-on tables are ready: off, ready, or failed to migrate. */
export type AddonDatabaseState = 'off' | 'ready' | 'failed';

/**
 * Prepares the add-on tables at startup. Does nothing when add-ons are off,
 * so a plain Bifröst install never gets them. A failed migration is logged
 * and reported as 'failed', never thrown: upstream awaits this before the
 * relay starts, and the relay must start without the add-ons.
 */
export async function initAddonDatabase(
    config: AddonConfig,
    sequelize: Sequelize,
    logger: AddonLogger
): Promise<AddonDatabaseState> {
    if (!config.enabled) return 'off';
    try {
        await runAddonMigrations(sequelize, logger);
        return 'ready';
    } catch (error) {
        logger.error(
            '[addons] Add-on migrations failed. Add-ons stay off; the relay keeps running.',
            error
        );
        return 'failed';
    }
}

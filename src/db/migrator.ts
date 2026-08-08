import path from 'path';
import { Umzug, SequelizeStorage } from 'umzug';
import sequelize from './sequelize';
import { DB_DIALECT, DB_HOST, DB_PORT, DB_NAME } from '../utils/env';
import logger from '../utils/logging/logger';

const storage = new SequelizeStorage({ sequelize });

const umzug = new Umzug({
    migrations: { glob: path.join(__dirname, 'migrations', '*.js') },
    context: sequelize.getQueryInterface(),
    storage,
    logger: undefined,
});

export type Migration = typeof umzug._types.migration;

const BASELINE_MIGRATION_NAME = '00001-baseline.js';

async function markBaselineAsAppliedIfPreExisting(): Promise<void> {
    const alreadyTracked = await storage.executed();
    if (alreadyTracked.length > 0) return;

    const queryInterface = sequelize.getQueryInterface();
    const tables = await queryInterface.showAllTables();
    const tableNames = tables.map((table) =>
        typeof table === 'string'
            ? table
            : (table as { tableName: string }).tableName
    );

    if (!tableNames.includes('channel_links')) return;

    logger.info(
        'Existing pre-migration database detected. Marking baseline schema as already applied.'
    );
    await storage.logMigration({ name: BASELINE_MIGRATION_NAME });
}

export const initDatabase = async (): Promise<void> => {
    try {
        await sequelize.authenticate();
        logger.info('Database connection has been established successfully.');

        await markBaselineAsAppliedIfPreExisting();

        const pending = await umzug.pending();
        if (pending.length > 0) {
            logger.info(
                `Applying ${pending.length} pending database migration${pending.length === 1 ? '' : 's'}: ${pending.map((m) => m.name).join(', ')}`
            );
        }

        await umzug.up();
        logger.info('Database migrations up to date.');
    } catch (error) {
        logger.error(
            'Unable to initialize database',
            {
                dialect: DB_DIALECT,
                host: DB_HOST,
                port: DB_PORT,
                database: DB_NAME,
            },
            error
        );
        process.exit(1);
    }
};

export default umzug;

import { Sequelize } from 'sequelize';
import path from 'path';
import { CONFIG_PATH, DB_DIALECT, DB_HOST, DB_NAME, DB_PASS, DB_PORT, DB_USER } from '../utils/env';
import logger from '../utils/logging/logger';

let sequelize: Sequelize;

if (DB_DIALECT === 'postgres') {
    sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
        host: DB_HOST,
        port: DB_PORT,
        dialect: 'postgres',
        logging: false,
    });
    logger.info('Using PostgreSQL database');
} else {
    sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: path.join(CONFIG_PATH, 'data.sqlite'),
        logging: false,
    });
    logger.info('Using SQLite database');
}

export const initDatabase = async () => {
    try {
        await sequelize.authenticate();
        logger.info('Database connection has been established successfully.');

        await sequelize.sync();
        logger.info('Database synchronized successfully.');
    } catch (error) {
        logger.error('Unable to connect to the database:', error);
        process.exit(1);
    }
};

export default sequelize;

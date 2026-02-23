import { Sequelize } from 'sequelize';
import path from 'path';
import { CONFIG_PATH } from '../utils/env';
import logger from '../utils/logging/logger';

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(CONFIG_PATH, 'data.sqlite'),
    logging: false,
});

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

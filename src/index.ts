import startFluxerClient from './fluxer';
import logger from './utils/logging/logger';

const main = async () => {
    await startFluxerClient();
};

main().catch((error) => {
    logger.error('An error occurred during the main execution:', error);
});

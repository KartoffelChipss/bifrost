import startDiscordClient from './discord';
import startFluxerClient from './fluxer';
import logger from './utils/logging/logger';

const main = async () => {
    const [discordClient, fluxerClient] = await Promise.all([
        startDiscordClient(),
        startFluxerClient(),
    ]);

    logger.info('Both Discord and Fluxer clients have started successfully.');
};

main();

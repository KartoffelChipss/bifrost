import { initDatabase } from './db/sequelize';
import { SequelizeChannelLinkRepository } from './db/sequelizerepos/SequelizeChannelLinkRepository';
import { SequelizeGuildLinkRepository } from './db/sequelizerepos/SequelizeGuildLinkRepository';
import startDiscordClient from './discord';
import startFluxerClient from './fluxer';
import { LinkService } from './services/LinkService';
import logger from './utils/logging/logger';

const main = async () => {
    await initDatabase();

    const guildLinkRepo = new SequelizeGuildLinkRepository();
    const channelLinkRepo = new SequelizeChannelLinkRepository();
    const linkService = new LinkService(guildLinkRepo, channelLinkRepo);

    const [discordClient, fluxerClient] = await Promise.all([
        startDiscordClient({ linkService }),
        startFluxerClient({ linkService }),
    ]);

    logger.info('Both Discord and Fluxer clients have started successfully.');
};

main();

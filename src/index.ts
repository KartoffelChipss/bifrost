import { CachedChannelLinkRepository } from './db/cachedrepos/CachedChannelLinkRepository';
import { CachedGuildLinkRepository } from './db/cachedrepos/CachedGuildLinkRepository';
import { initDatabase } from './db/sequelize';
import { SequelizeChannelLinkRepository } from './db/sequelizerepos/SequelizeChannelLinkRepository';
import { SequelizeGuildLinkRepository } from './db/sequelizerepos/SequelizeGuildLinkRepository';
import startDiscordClient from './discord';
import startFluxerClient from './fluxer';
import { LinkService } from './services/LinkService';
import { WebhookService } from './services/WebhookService';
import logger from './utils/logging/logger';

const main = async () => {
    await initDatabase();

    const guildLinkRepo = new SequelizeGuildLinkRepository();
    const channelLinkRepo = new SequelizeChannelLinkRepository();

    const cachedGuildLinkRepo = new CachedGuildLinkRepository(guildLinkRepo, 0);
    const cachedChannelLinkRepo = new CachedChannelLinkRepository(channelLinkRepo, 0);

    const linkService = new LinkService(cachedGuildLinkRepo, cachedChannelLinkRepo);
    const webhookService = new WebhookService(linkService);

    const [discordClient, fluxerClient] = await Promise.all([
        startDiscordClient({ linkService, webhookService }),
        startFluxerClient({ linkService, webhookService }),
    ]);

    logger.info('Both Discord and Fluxer clients have started successfully.');
};

main();

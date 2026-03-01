import { CachedChannelLinkRepository } from './db/cachedrepos/CachedChannelLinkRepository';
import { CachedGuildLinkRepository } from './db/cachedrepos/CachedGuildLinkRepository';
import { CachedMessageLinkRepository } from './db/cachedrepos/CachedMessageLinkRepository';
import { initDatabase } from './db/sequelize';
import { SequelizeChannelLinkRepository } from './db/sequelizerepos/SequelizeChannelLinkRepository';
import { SequelizeGuildLinkRepository } from './db/sequelizerepos/SequelizeGuildLinkRepository';
import { SequelizeMessageLinkRepository } from './db/sequelizerepos/SequelizeMessageLinkRepository';
import startDiscordClient from './discord';
import startFluxerClient from './fluxer';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import HealthCheckService from './services/HealthCheckService';
import { LinkService } from './services/LinkService';
import { WebhookService } from './services/WebhookService';
import {
    DISCORD_APPLICATION_ID,
    DISCORD_HEALTH_PUSH_URL,
    FLUXER_APPLICATION_ID,
    FLUXER_HEALTH_PUSH_URL,
} from './utils/env';
import {
    generateDiscordBotInviteLink,
    generateFluxerBotInviteLink,
} from './utils/generateBotInvite';
import logger from './utils/logging/logger';

const main = async () => {
    await initDatabase();

    const healthCheckService = new HealthCheckService(
        DISCORD_HEALTH_PUSH_URL || null,
        FLUXER_HEALTH_PUSH_URL || null
    );

    const guildLinkRepo = new SequelizeGuildLinkRepository();
    const channelLinkRepo = new SequelizeChannelLinkRepository();
    const messageLinkRepo = new SequelizeMessageLinkRepository();

    const cachedGuildLinkRepo = new CachedGuildLinkRepository(guildLinkRepo, 0);
    const cachedChannelLinkRepo = new CachedChannelLinkRepository(channelLinkRepo, 0);
    const cachedMessageLinkRepo = new CachedMessageLinkRepository(messageLinkRepo, 15_000);

    const linkService = new LinkService(
        cachedGuildLinkRepo,
        cachedChannelLinkRepo,
        cachedMessageLinkRepo
    );
    const webhookService = new WebhookService(linkService);
    const discordEntityResolver = new DiscordEntityResolver();
    const fluxerEntityResolver = new FluxerEntityResolver();

    const perms = '536947712';
    const discordBotInviteLink = generateDiscordBotInviteLink(DISCORD_APPLICATION_ID, perms);
    logger.info(`Discord Bot Invite Link: ${discordBotInviteLink}`);
    const fluxerBotInviteLink = generateFluxerBotInviteLink(FLUXER_APPLICATION_ID, perms);
    logger.info(`Fluxer Bot Invite Link: ${fluxerBotInviteLink}`);

    await Promise.all([
        startDiscordClient({
            linkService,
            webhookService,
            healthCheckService,
            discordEntityResolver,
            fluxerEntityResolver,
        }),
        startFluxerClient({
            linkService,
            webhookService,
            healthCheckService,
            discordEntityResolver,
            fluxerEntityResolver,
        }),
    ]);

    logger.info('Both Discord and Fluxer clients have started successfully.');
};

main();

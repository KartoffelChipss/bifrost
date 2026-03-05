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
import MetricsService from './services/MetricsService';
import MessageQueueService from './services/MessageQueueService';
import { LinkService } from './services/LinkService';
import { WebhookService } from './services/WebhookService';
import {
    DISCORD_APP_ID,
    DISCORD_HEALTH_URL,
    FLUXER_APP_ID,
    FLUXER_HEALTH_URL,
} from './utils/env';
import {
    generateDiscordBotInviteLink,
    generateFluxerBotInviteLink,
} from './utils/generateBotInvite';
import logger from './utils/logging/logger';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import { DbStatsService } from './services/DbStatsService';

const main = async () => {
    await initDatabase();

    const metricsService = new MetricsService(METRICS_PORT);
    const queueService = new MessageQueueService(QUEUE_TTL_MS);

    const healthCheckService = new HealthCheckService(
        DISCORD_HEALTH_URL || null,
        FLUXER_HEALTH_URL || null
    );
    healthCheckService.setMetricsService(metricsService);

    const guildLinkRepo = new SequelizeGuildLinkRepository();
    const channelLinkRepo = new SequelizeChannelLinkRepository();
    const messageLinkRepo = new SequelizeMessageLinkRepository();

    const cachedGuildLinkRepo = new CachedGuildLinkRepository(guildLinkRepo, 0);
    const cachedChannelLinkRepo = new CachedChannelLinkRepository(
        channelLinkRepo,
        0
    );
    const cachedMessageLinkRepo = new CachedMessageLinkRepository(
        messageLinkRepo,
        15_000
    );

    const linkService = new LinkService(
        cachedGuildLinkRepo,
        cachedChannelLinkRepo,
        cachedMessageLinkRepo
    );
    const webhookService = new WebhookService();
    const discordEntityResolver = new DiscordEntityResolver();
    const fluxerEntityResolver = new FluxerEntityResolver();
    const discordStatsService = new DiscordStatsService();
    const fluxerStatsService = new FluxerStatsService();
    const dbStatsService = new DbStatsService(channelLinkRepo, messageLinkRepo);

    const FLUXER_DOWN_THRESHOLD = 5; // 5 × 30s = 2.5 min before restart
    const FLUXER_MAX_RESTARTS = 3; // restart up to N times, then long backoff
    const FLUXER_BACKOFF_MS = 20 * 60_000; // 20 min wait after exhausting restarts

    const fluxerArgs = {
        linkService,
        webhookService,
        healthCheckService,
        discordEntityResolver,
        fluxerEntityResolver,
        discordStatsService,
        fluxerStatsService,
        dbStatsService,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fluxerClientRef: { current: any } = { current: null };
    let fluxerRestartAttempts = 0;
    let fluxerRestartState: 'idle' | 'restarting' | 'backoff' = 'idle';

    const doFluxerRestart = async () => {
        fluxerRestartState = 'restarting';
        fluxerRestartAttempts++;
        logger.warn(
            `[Fluxer] Restarting client (attempt #${fluxerRestartAttempts})...`
        );
        healthCheckService.resetFluxerDownCount();
        try {
            fluxerClientRef.current?.destroy?.();
        } catch (err) {
            logger.error('Error destroying Fluxer client during restart:', err);
        }
        await new Promise((r) => setTimeout(r, 3_000));
        try {
            fluxerClientRef.current = await startFluxerClient(fluxerArgs);
            logger.info(
                `[Fluxer] Client restarted successfully (attempt #${fluxerRestartAttempts})`
            );
            fluxerRestartState = 'idle';
        } catch (err) {
            logger.error(
                `[Fluxer] Restart #${fluxerRestartAttempts} failed:`,
                err
            );
            enterFluxerBackoff();
        }
    };

    const enterFluxerBackoff = () => {
        fluxerRestartState = 'backoff';
        healthCheckService.resetFluxerDownCount();
        logger.warn(
            `[Fluxer] Entering ${FLUXER_BACKOFF_MS / 60_000}-minute backoff before next restart`
        );
        setTimeout(() => {
            fluxerRestartState = 'idle';
            doFluxerRestart().catch((err) =>
                logger.error('[Fluxer] Restart after backoff failed:', err)
            );
        }, FLUXER_BACKOFF_MS);
    };

    healthCheckService.setOnFluxerRecovered(() => {
        fluxerRestartAttempts = 0;
    });
    healthCheckService.setOnFluxerDown((count) => {
        if (fluxerRestartState !== 'idle') return;
        if (count < FLUXER_DOWN_THRESHOLD) return;
        if (fluxerRestartAttempts >= FLUXER_MAX_RESTARTS) {
            enterFluxerBackoff();
            return;
        }
        doFluxerRestart().catch((err) =>
            logger.error('[Fluxer] Restart error:', err)
        );
    });

    const FLUXER_DOWN_THRESHOLD = 5;        // 5 × 30s = 2.5 min before restart
    const FLUXER_MAX_RESTARTS = 3;          // restart up to N times, then long backoff
    const FLUXER_BACKOFF_MS = 20 * 60_000; // 20 min wait after exhausting restarts

    const fluxerArgs = {
        linkService,
        webhookService,
        healthCheckService,
        discordEntityResolver,
        fluxerEntityResolver,
        metricsService,
        queueService,
        discordStatsService,
        fluxerStatsService,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fluxerClientRef: { current: any } = { current: null };
    let fluxerRestartAttempts = 0;
    let fluxerRestartState: 'idle' | 'restarting' | 'backoff' = 'idle';

    const doFluxerRestart = async () => {
        fluxerRestartState = 'restarting';
        fluxerRestartAttempts++;
        logger.warn(`[Fluxer] Restarting client (attempt #${fluxerRestartAttempts})...`);
        healthCheckService.resetFluxerDownCount();
        try { fluxerClientRef.current?.destroy?.(); } catch {}
        await new Promise(r => setTimeout(r, 3_000));
        try {
            fluxerClientRef.current = await startFluxerClient(fluxerArgs);
            logger.info(`[Fluxer] Client restarted successfully (attempt #${fluxerRestartAttempts})`);
            fluxerRestartState = 'idle';
        } catch (err) {
            logger.error(`[Fluxer] Restart #${fluxerRestartAttempts} failed:`, err);
            enterFluxerBackoff();
        }
    };

    const enterFluxerBackoff = () => {
        fluxerRestartState = 'backoff';
        healthCheckService.resetFluxerDownCount();
        logger.warn(`[Fluxer] Entering ${FLUXER_BACKOFF_MS / 60_000}-minute backoff before next restart`);
        setTimeout(() => {
            fluxerRestartState = 'idle';
            doFluxerRestart().catch((err) => logger.error('[Fluxer] Restart after backoff failed:', err));
        }, FLUXER_BACKOFF_MS);
    };

    healthCheckService.setOnDiscordRecovered(() => {
        queueService.drain(webhookService, linkService).catch((err) =>
            logger.error('Queue drain on Discord recovery error:', err)
        );
    });
    healthCheckService.setOnFluxerRecovered(() => {
        fluxerRestartAttempts = 0;
        queueService.drain(webhookService, linkService).catch((err) =>
            logger.error('Queue drain on Fluxer recovery error:', err)
        );
    });
    healthCheckService.setOnFluxerDown((count) => {
        if (fluxerRestartState !== 'idle') return;
        if (count < FLUXER_DOWN_THRESHOLD) return;
        if (fluxerRestartAttempts >= FLUXER_MAX_RESTARTS) {
            enterFluxerBackoff();
            return;
        }
        doFluxerRestart().catch((err) => logger.error('[Fluxer] Restart error:', err));
    });

    const perms = '536947712';
    const discordBotInviteLink = generateDiscordBotInviteLink(
        DISCORD_APP_ID,
        perms
    );
    logger.info(`Discord Bot Invite Link: ${discordBotInviteLink}`);
    const fluxerBotInviteLink = generateFluxerBotInviteLink(
        FLUXER_APP_ID,
        perms
    );
    logger.info(`Fluxer Bot Invite Link: ${fluxerBotInviteLink}`);

    const [, initialFluxerClient] = await Promise.all([
        startDiscordClient({
            linkService,
            webhookService,
            healthCheckService,
            discordEntityResolver,
            fluxerEntityResolver,
            metricsService,
            queueService,
            discordStatsService,
            fluxerStatsService,
            dbStatsService,
        }),
        startFluxerClient(fluxerArgs),
    ]);
    fluxerClientRef.current = initialFluxerClient;

    setInterval(async () => {
        await healthCheckService.pushFluxerHealthStatus();
    }, 30_000);

    logger.info('Both Discord and Fluxer clients have started successfully.');
};

main();

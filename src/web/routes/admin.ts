import { Router } from 'express';
import type { Client as DiscordClient } from 'discord.js';
import { LinkService } from '../../services/LinkService';
import { WebhookService } from '../../services/WebhookService';
import { DbStatsService } from '../../services/DbStatsService';
import type StatsService from '../../services/statsService/StatsService';
import { getHeapUsageMB } from '../../utils/memory';
import { GIT_COMMIT, REPO_URL } from '../../utils/env';
import type { FluxerClientRef } from '../clientRefs';
import { requireOwner } from '../middleware/auth';
import type { AdminStatsResponse } from '../types';

export function createAdminRouter({
    discordClient,
    fluxerClientRef,
    discordStatsService,
    fluxerStatsService,
    dbStatsService,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    discordClient: DiscordClient;
    fluxerClientRef: FluxerClientRef;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    discordStatsService: StatsService<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fluxerStatsService: StatsService<any>;
    dbStatsService: DbStatsService;
}): Router {
    const router = Router();

    router.use(requireOwner);

    router.get('/admin/stats', async (_req, res) => {
        const discordGuildCount = discordStatsService.getGuildCount();
        const fluxerGuildCount = fluxerStatsService.getGuildCount();
        const discordUserCount = discordStatsService.getUserCount();
        const fluxerUserCount = fluxerStatsService.getUserCount();
        const discordPingMs = await discordStatsService.getPing();
        const fluxerPingMs = await fluxerStatsService.getPing();
        const dbStats = await dbStatsService.getStats();

        const response: AdminStatsResponse = {
            discordGuildCount: Number.isNaN(discordGuildCount)
                ? null
                : discordGuildCount,
            fluxerGuildCount: Number.isNaN(fluxerGuildCount)
                ? null
                : fluxerGuildCount,
            discordUserCount: Number.isNaN(discordUserCount)
                ? null
                : discordUserCount,
            fluxerUserCount: Number.isNaN(fluxerUserCount)
                ? null
                : fluxerUserCount,
            discordPingMs: Number.isNaN(discordPingMs) ? null : discordPingMs,
            fluxerPingMs: Number.isNaN(fluxerPingMs) ? null : fluxerPingMs,
            channelLinksCount: dbStats.channelLinksCount,
            messageLinksCount: dbStats.messageLinksCount,
            uptimeSeconds: process.uptime(),
            memoryUsageMB: Number(getHeapUsageMB()),
            gitCommit: GIT_COMMIT,
            repoUrl: REPO_URL,
            discordHealthy: discordClient.ws.status === 0,
            fluxerHealthy: fluxerClientRef.current?.isReady() ?? false,
        };
        res.json(response);
    });

    return router;
}

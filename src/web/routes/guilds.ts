import { Router } from 'express';
import type { Client as DiscordClient } from 'discord.js';
import { LinkService } from '../../services/LinkService';
import { WebhookService } from '../../services/WebhookService';
import logger from '../../utils/logging/logger';
import type { FluxerClientRef } from '../clientRefs';
import {
    DiscordManageGuild,
    FluxerManageGuild,
    hasDiscordGuildPermission,
    hasFluxerGuildPermission,
    requireBoth,
} from '../middleware/auth';
import type {
    CreateGuildLinkBody,
    GuildPair,
    GuildsResponse,
    GuildSummary,
} from '../types';

export function createGuildsRouter({
    linkService,
    webhookService,
    discordClient,
    fluxerClientRef,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    discordClient: DiscordClient;
    fluxerClientRef: FluxerClientRef;
}): Router {
    const router = Router();

    router.get('/guilds', async (req, res) => {
        const fluxerClient = fluxerClientRef.current;
        const discordGuilds = (req.session.discord?.guilds ?? []).filter((g) =>
            hasDiscordGuildPermission(req, g.id, DiscordManageGuild)
        );
        const fluxerGuilds = (req.session.fluxer?.guilds ?? []).filter((g) =>
            hasFluxerGuildPermission(req, g.id, FluxerManageGuild)
        );

        const allLinks = await linkService.getAllGuildLinks();

        const linkedDiscordIds = new Set<string>();
        const linkedFluxerIds = new Set<string>();
        const linkedPairs: GuildPair[] = [];

        for (const link of allLinks) {
            const discordManaged = discordGuilds.find(
                (g) => g.id === link.discordGuildId
            );
            const fluxerManaged = fluxerGuilds.find(
                (g) => g.id === link.fluxerGuildId
            );
            // Only surface pairs the current user actually manages on at least one side.
            if (!discordManaged && !fluxerManaged) continue;

            linkedDiscordIds.add(link.discordGuildId);
            linkedFluxerIds.add(link.fluxerGuildId);

            const discordGuildLive = discordClient.guilds.cache.get(
                link.discordGuildId
            );
            const fluxerGuildLive = fluxerClient?.guilds.get(
                link.fluxerGuildId
            );

            const discord: GuildSummary = discordManaged
                ? {
                      id: discordManaged.id,
                      name: discordManaged.name,
                      icon: discordManaged.icon,
                      botPresent: !!discordGuildLive,
                  }
                : {
                      id: link.discordGuildId,
                      name: discordGuildLive?.name ?? link.discordGuildId,
                      icon: null,
                      botPresent: !!discordGuildLive,
                  };

            const fluxer: GuildSummary = fluxerManaged
                ? {
                      id: fluxerManaged.id,
                      name: fluxerManaged.name,
                      icon: fluxerManaged.icon,
                      botPresent: !!fluxerGuildLive,
                  }
                : {
                      id: link.fluxerGuildId,
                      name: fluxerGuildLive?.name ?? link.fluxerGuildId,
                      icon: null,
                      botPresent: !!fluxerGuildLive,
                  };

            linkedPairs.push({ guildLinkId: link.id, discord, fluxer });
        }

        const unlinkedDiscordGuilds: GuildSummary[] = discordGuilds
            .filter((g) => !linkedDiscordIds.has(g.id))
            .map((g) => ({
                id: g.id,
                name: g.name,
                icon: g.icon,
                botPresent: discordClient.guilds.cache.has(g.id),
            }));

        const unlinkedFluxerGuilds: GuildSummary[] = fluxerGuilds
            .filter((g) => !linkedFluxerIds.has(g.id))
            .map((g) => ({
                id: g.id,
                name: g.name,
                icon: g.icon,
                botPresent: fluxerClient?.guilds.has(g.id) ?? false,
            }));

        const response: GuildsResponse = {
            linkedPairs,
            unlinkedDiscordGuilds,
            unlinkedFluxerGuilds,
        };
        res.json(response);
    });

    router.post('/guild-links', requireBoth, async (req, res) => {
        const { discordGuildId, fluxerGuildId } =
            req.body as Partial<CreateGuildLinkBody>;
        if (!discordGuildId || !fluxerGuildId) {
            res.status(400).json({
                error: 'discordGuildId and fluxerGuildId are required',
            });
            return;
        }
        if (
            !hasDiscordGuildPermission(req, discordGuildId, DiscordManageGuild)
        ) {
            res.status(403).json({
                error: 'You do not manage that Discord guild',
            });
            return;
        }
        if (!hasFluxerGuildPermission(req, fluxerGuildId, FluxerManageGuild)) {
            res.status(403).json({
                error: 'You do not manage that Fluxer guild',
            });
            return;
        }

        try {
            const link = await linkService.createGuildLink(
                discordGuildId,
                fluxerGuildId
            );
            res.status(201).json({ guildLinkId: link.id });
        } catch (err) {
            res.status(409).json({ error: (err as Error).message });
        }
    });

    router.delete('/guild-links/:id', async (req, res) => {
        const link = await linkService.getGuildLinkById(req.params.id);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const canManage =
            hasDiscordGuildPermission(
                req,
                link.discordGuildId,
                DiscordManageGuild
            ) ||
            hasFluxerGuildPermission(
                req,
                link.fluxerGuildId,
                FluxerManageGuild
            );
        if (!canManage) {
            res.status(403).json({
                error: 'You do not manage either linked guild',
            });
            return;
        }

        try {
            const channelLinks = await linkService
                .getChannelLinksForDiscordGuild(link.discordGuildId)
                .catch(() => []);
            for (const channelLink of channelLinks) {
                await webhookService
                    .deleteDiscordWebhook(
                        channelLink.discordWebhookId,
                        channelLink.discordWebhookToken
                    )
                    .catch((err) =>
                        logger.error(
                            'Failed to delete Discord webhook during guild unlink:',
                            err
                        )
                    );
                await webhookService
                    .deleteFluxerWebhook(
                        channelLink.fluxerWebhookId,
                        channelLink.fluxerWebhookToken
                    )
                    .catch((err) =>
                        logger.error(
                            'Failed to delete Fluxer webhook during guild unlink:',
                            err
                        )
                    );
            }
            await linkService.removeGuildLinkFromDiscord(link.discordGuildId);
            res.status(204).end();
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    return router;
}

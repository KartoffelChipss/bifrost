import { Router, Request } from 'express';
import { ChannelType, TextChannel as DiscordTextChannel } from 'discord.js';
import type { Client as DiscordClient } from 'discord.js';
import { GuildLink } from '../../db/entities/GuildLink';
import { LinkService } from '../../services/LinkService';
import { WebhookService } from '../../services/WebhookService';
import { matchChannels } from '../../utils/channelMatcher';
import logger from '../../utils/logging/logger';
import type { FluxerClientRef } from '../clientRefs';
import {
    DiscordManageWebhooks,
    FluxerManageWebhooks,
    hasDiscordGuildPermission,
    hasFluxerGuildPermission,
} from '../middleware/auth';
import type {
    AutolinkPreviewResponse,
    AutolinkResponse,
    AutolinkResultItem,
    ChannelLinkSummary,
    ChannelSummary,
    CreateChannelLinkBody,
    GuildChannelsResponse,
} from '../types';

export function createChannelsRouter({
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

    function assertChannelPermission(
        req: Request,
        discordGuildId: string,
        fluxerGuildId: string
    ): string | null {
        const okDiscord = hasDiscordGuildPermission(
            req,
            discordGuildId,
            DiscordManageWebhooks
        );
        const okFluxer = hasFluxerGuildPermission(
            req,
            fluxerGuildId,
            FluxerManageWebhooks
        );
        if (!okDiscord && !okFluxer) {
            return 'You do not have Manage Webhooks on either linked guild';
        }
        return null;
    }

    async function getChannelState(link: GuildLink) {
        const channelLinks = await linkService.getChannelLinksForDiscordGuild(
            link.discordGuildId
        );

        const discordGuild = discordClient.guilds.cache.get(
            link.discordGuildId
        );
        const fluxerGuild = fluxerClientRef.current?.guilds.get(
            link.fluxerGuildId
        );

        const discordChannels: ChannelSummary[] = discordGuild
            ? [...discordGuild.channels.cache.values()]
                  .filter(
                      (c): c is DiscordTextChannel =>
                          c.type === ChannelType.GuildText
                  )
                  .map((c) => ({ id: c.id, name: c.name }))
            : [];

        const fluxerChannels: ChannelSummary[] = fluxerGuild
            ? (await fluxerGuild.fetchChannels())
                  .filter((c) => c.isTextBased())
                  .map((c) => ({ id: c.id, name: c.name ?? c.id }))
            : [];

        const linkedDiscordIds = new Set(
            channelLinks.map((l) => l.discordChannelId)
        );
        const linkedFluxerIds = new Set(
            channelLinks.map((l) => l.fluxerChannelId)
        );

        return {
            channelLinks,
            discordChannels,
            fluxerChannels,
            unlinkedDiscordChannels: discordChannels.filter(
                (c) => !linkedDiscordIds.has(c.id)
            ),
            unlinkedFluxerChannels: fluxerChannels.filter(
                (c) => !linkedFluxerIds.has(c.id)
            ),
        };
    }

    router.get('/guild-links/:id/channels', async (req, res) => {
        const link = await linkService.getGuildLinkById(req.params.id);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        const {
            channelLinks,
            discordChannels,
            fluxerChannels,
            unlinkedDiscordChannels,
            unlinkedFluxerChannels,
        } = await getChannelState(link);

        const linked: ChannelLinkSummary[] = channelLinks.map((l) => ({
            id: l.id,
            discordChannel: {
                id: l.discordChannelId,
                name:
                    discordChannels.find((c) => c.id === l.discordChannelId)
                        ?.name ?? l.discordChannelId,
            },
            fluxerChannel: {
                id: l.fluxerChannelId,
                name:
                    fluxerChannels.find((c) => c.id === l.fluxerChannelId)
                        ?.name ?? l.fluxerChannelId,
            },
        }));

        const response: GuildChannelsResponse = {
            linked,
            unlinkedDiscordChannels,
            unlinkedFluxerChannels,
        };
        res.json(response);
    });

    router.get('/guild-links/:id/autolink', async (req, res) => {
        const link = await linkService.getGuildLinkById(req.params.id);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        const { unlinkedDiscordChannels, unlinkedFluxerChannels } =
            await getChannelState(link);
        const matches = matchChannels(
            unlinkedDiscordChannels,
            unlinkedFluxerChannels
        );

        const response: AutolinkPreviewResponse = {
            proposals: matches.map((m) => ({
                discordChannel: m.discord,
                fluxerChannel: m.fluxer,
                score: m.score,
            })),
            unmatchedDiscordCount:
                unlinkedDiscordChannels.length - matches.length,
            unmatchedFluxerCount:
                unlinkedFluxerChannels.length - matches.length,
        };
        res.json(response);
    });

    router.post('/guild-links/:id/autolink', async (req, res) => {
        const link = await linkService.getGuildLinkById(req.params.id);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        const { unlinkedDiscordChannels, unlinkedFluxerChannels } =
            await getChannelState(link);
        const matches = matchChannels(
            unlinkedDiscordChannels,
            unlinkedFluxerChannels
        );

        const results: AutolinkResultItem[] = [];
        let linkedCount = 0;

        for (const match of matches) {
            try {
                const discordWebhook =
                    await webhookService.createDiscordWebhook(
                        match.discord.id,
                        `Fluxer Bridge Webhook for channel ${match.discord.id}`
                    );
                const fluxerWebhook = await webhookService.createFluxerWebhook(
                    match.fluxer.id,
                    `Discord Bridge Webhook for channel ${match.fluxer.id}`
                );
                await linkService.createChannelLink({
                    guildLinkId: link.id,
                    discordChannelId: match.discord.id,
                    fluxerChannelId: match.fluxer.id,
                    discordWebhookId: discordWebhook.id,
                    discordWebhookToken: discordWebhook.token,
                    fluxerWebhookId: fluxerWebhook.id,
                    fluxerWebhookToken: fluxerWebhook.token,
                });
                linkedCount++;
                results.push({
                    discordChannel: match.discord,
                    fluxerChannel: match.fluxer,
                });
            } catch (err) {
                logger.error(
                    `Autolink failed for #${match.discord.name} ↔ #${match.fluxer.name}:`,
                    err
                );
                results.push({
                    discordChannel: match.discord,
                    fluxerChannel: match.fluxer,
                    error: (err as Error).message,
                });
            }
        }

        const response: AutolinkResponse = { linkedCount, results };
        res.json(response);
    });

    router.post('/channel-links', async (req, res) => {
        const { guildLinkId, discordChannelId, fluxerChannelId } =
            req.body as Partial<CreateChannelLinkBody>;
        if (!guildLinkId || !discordChannelId || !fluxerChannelId) {
            res.status(400).json({
                error: 'guildLinkId, discordChannelId and fluxerChannelId are required',
            });
            return;
        }

        const link = await linkService.getGuildLinkById(guildLinkId);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        try {
            const discordWebhook = await webhookService.createDiscordWebhook(
                discordChannelId,
                `Fluxer Bridge Webhook for channel ${discordChannelId}`
            );
            const fluxerWebhook = await webhookService.createFluxerWebhook(
                fluxerChannelId,
                `Discord Bridge Webhook for channel ${fluxerChannelId}`
            );
            const channelLink = await linkService.createChannelLink({
                guildLinkId,
                discordChannelId,
                fluxerChannelId,
                discordWebhookId: discordWebhook.id,
                discordWebhookToken: discordWebhook.token,
                fluxerWebhookId: fluxerWebhook.id,
                fluxerWebhookToken: fluxerWebhook.token,
            });
            res.status(201).json({ id: channelLink.id });
        } catch (err) {
            logger.error('Failed to create channel link via dashboard:', err);
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.delete('/channel-links/:id', async (req, res) => {
        const channelLink = await linkService.getChannelLinkById(req.params.id);
        if (!channelLink) {
            res.status(404).json({ error: 'Channel link not found' });
            return;
        }
        const guildLink = await linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            guildLink.discordGuildId,
            guildLink.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        try {
            await webhookService
                .deleteDiscordWebhook(
                    channelLink.discordWebhookId,
                    channelLink.discordWebhookToken
                )
                .catch((err) =>
                    logger.error('Failed to delete Discord webhook:', err)
                );
            await webhookService
                .deleteFluxerWebhook(
                    channelLink.fluxerWebhookId,
                    channelLink.fluxerWebhookToken
                )
                .catch((err) =>
                    logger.error('Failed to delete Fluxer webhook:', err)
                );
            await linkService.removeChannelLinkForDiscord(
                guildLink.discordGuildId,
                channelLink.linkId
            );
            res.status(204).end();
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    return router;
}

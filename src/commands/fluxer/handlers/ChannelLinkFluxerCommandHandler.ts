import { Client, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { WebhookService } from '../../../services/WebhookService';
import { getFluxerCommandUsage } from '../../../commands/commandList';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import { createFluxerErrorReply, createFluxerSuccessReply } from '../../../utils/embeds';

export default class ChannelLinkFluxerCommandHandler extends FluxerCommandHandler {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;
    private readonly discordEntityResolver: DiscordEntityResolver;

    constructor(
        client: Client,
        linkService: LinkService,
        webhookService: WebhookService,
        discordEntityResolver: DiscordEntityResolver
    ) {
        super(client);
        this.linkService = linkService;
        this.webhookService = webhookService;
        this.discordEntityResolver = discordEntityResolver;
    }

    public async handleCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlags.ManageChannels,
            'Manage Channels'
        );
        if (!hasPerms) return;

        if (args.length < 1 || args[0].toLowerCase() == 'help') {
            const usage = getFluxerCommandUsage(command);
            await message.reply(usage);
            return;
        }

        const rawChannelId = args[0];
        const discordChannelId = rawChannelId.replace(/^<|>$/g, '');

        let guildLink = null;
        try {
            guildLink = await this.linkService.getGuildLinkForFluxerGuild(message.guildId!);
            if (!guildLink) {
                throw new Error('Guild not linked');
            }
        } catch (error: any) {
            await message.reply(
                createFluxerErrorReply(
                    `Failed to get guild link: ${error.message}`,
                    'Error Fetching Guild Link'
                )
            );
            logger.error('Error fetching guild link:', error);
            return;
        }

        try {
            const discordChannel = await this.discordEntityResolver.fetchChannel(
                guildLink.discordGuildId,
                discordChannelId
            );
            if (!discordChannel) {
                throw new Error('Discord channel not found');
            }
        } catch (error: any) {
            await message.reply(
                createFluxerErrorReply(
                    `Linking failed: Could not find Discord channel with ID \`${discordChannelId}\`.`,
                    'Discord Channel Not Found'
                )
            );
            logger.error('Error fetching Discord channel:', error);
            return;
        }

        let discordWebhook = null;
        try {
            discordWebhook = await this.webhookService.createDiscordWebhook(
                discordChannelId,
                `Fluxer Bridge Webhook for channel ${message.channelId}`
            );
        } catch (error: any) {
            await message.reply(
                createFluxerErrorReply(
                    `Failed to create Discord webhook: ${error.message}`,
                    'Error Creating Discord Webhook'
                )
            );
            logger.error('Error creating Discord webhook:', error);
            return;
        }

        let fluxerWebhook = null;
        try {
            fluxerWebhook = await this.webhookService.createFluxerWebhook(
                message.channelId,
                `Discord Bridge Webhook for channel ${message.channelId}`
            );
        } catch (error: any) {
            await message.reply(
                createFluxerErrorReply(
                    `Failed to create Fluxer webhook: ${error.message}`,
                    'Error Creating Fluxer Webhook'
                )
            );
            logger.error('Error creating Fluxer webhook:', error);
            return;
        }

        try {
            await this.linkService.createChannelLink({
                guildLinkId: guildLink.id,
                discordChannelId,
                fluxerChannelId: message.channelId,
                discordWebhookId: discordWebhook.id,
                discordWebhookToken: discordWebhook.token,
                fluxerWebhookId: fluxerWebhook.id,
                fluxerWebhookToken: fluxerWebhook.token,
            });
            await message.reply(
                createFluxerSuccessReply(
                    `Successfully linked this Fluxer channel to Discord channel ID \`${discordChannelId}\`.`,
                    'Channel Linked'
                )
            );
        } catch (error: any) {
            await message.reply(
                createFluxerErrorReply(
                    `Failed to create channel link: ${error.message}`,
                    'Error Creating Channel Link'
                )
            );
            logger.error('Error creating channel link:', error);
        }
    }
}

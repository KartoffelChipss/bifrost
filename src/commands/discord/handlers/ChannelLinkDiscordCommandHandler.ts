import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { Client, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { WebhookService } from '../../../services/WebhookService';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import { createDiscordErrorReply, createDiscordSuccessReply } from '../../../utils/embeds';

export default class ChannelLinkDiscordCommandHandler extends DiscordCommandHandler {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;
    private readonly fluxerEntityResolver: FluxerEntityResolver;

    constructor(
        client: Client,
        linkService: LinkService,
        webhookService: WebhookService,
        fluxerEntityResolver: FluxerEntityResolver
    ) {
        super(client);
        this.linkService = linkService;
        this.webhookService = webhookService;
        this.fluxerEntityResolver = fluxerEntityResolver;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageChannels,
            'Manage Channels'
        );
        if (!hasPerms) return;

        if (args.length < 1 || args[0].toLowerCase() === 'help') {
            const usage = getDiscordCommandUsage(command);
            await message.reply(usage);
            return;
        }

        const rawChannelId = args[0];
        const fluxerChannelId = rawChannelId.replace(/^<|>$/g, '');

        let guildLink = null;
        try {
            guildLink = await this.linkService.getGuildLinkForDiscordGuild(message.guildId!);
            if (!guildLink) {
                throw new Error('Guild not linked');
            }
        } catch (error: any) {
            await message.reply(
                createDiscordErrorReply(
                    `Failed to get guild link: ${error.message}`,
                    'Error Fetching Guild Link'
                )
            );
            logger.error('Error fetching guild link:', error);
            return;
        }

        try {
            const c = await this.fluxerEntityResolver.fetchChannel(
                guildLink.fluxerGuildId,
                fluxerChannelId
            );
            if (!c) throw new Error('Channel not found');
        } catch (error: any) {
            await message.reply(
                createDiscordErrorReply(
                    `Linking failed: Could not find Fluxer channel with ID \`${fluxerChannelId}\`.`,
                    'Channel Not Found'
                )
            );
            logger.error('Error fetching Fluxer channel:', error);
            return;
        }

        let discordWebhook = null;
        try {
            discordWebhook = await this.webhookService.createDiscordWebhook(
                message.channelId,
                `Fluxer Bridge Webhook for channel ${message.channelId}`
            );
        } catch (error: any) {
            await message.reply(
                createDiscordErrorReply(
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
                fluxerChannelId,
                `Discord Bridge Webhook for channel ${fluxerChannelId}`
            );
        } catch (error: any) {
            await message.reply(
                createDiscordErrorReply(
                    `Failed to create Fluxer webhook: ${error.message}`,
                    'Error Creating Fluxer Webhook'
                )
            );
            logger.error('Error creating Fluxer webhook:', error);
            return;
        }

        try {
            await this.linkService.createChannelLink({
                guildLinkId: guildLink!.id,
                discordChannelId: message.channelId,
                fluxerChannelId,
                discordWebhookId: discordWebhook.id,
                discordWebhookToken: discordWebhook.token,
                fluxerWebhookId: fluxerWebhook.id,
                fluxerWebhookToken: fluxerWebhook.token,
            });
            await message.reply(
                createDiscordSuccessReply(
                    `Successfully linked this Discord channel to Fluxer channel ID \`${fluxerChannelId}\`.`,
                    'Channel Linked'
                )
            );
        } catch (error: any) {
            await message.reply(
                createDiscordErrorReply(
                    `Failed to create channel link: ${error.message}`,
                    'Error Creating Channel Link'
                )
            );
            logger.error('Error creating channel link:', error);
        }
    }
}

import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { WebhookService } from '../../../services/WebhookService';
import { getFluxerCommandUsage } from '../../../commands/commandList';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import { EmbedColors } from '../../../utils/embeds';

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
        const footer = this.footer(message);

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

        let guildLink;
        try {
            guildLink = await this.linkService.getGuildLinkForFluxerGuild(
                message.guildId!
            );
            if (!guildLink) {
                throw new Error('Guild not linked');
            }
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Fetching Guild Link')
                        .setDescription(
                            `Failed to get guild link: ${errorMessage}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error(
                'Failed fetching guild link for Fluxer channel link command',
                {
                    command,
                    fluxerGuildId: message.guildId,
                    fluxerChannelId: message.channelId,
                    discordChannelId,
                },
                error
            );
            return;
        }

        try {
            const discordChannel =
                await this.discordEntityResolver.fetchChannel(
                    guildLink.discordGuildId,
                    discordChannelId
                );
            if (!discordChannel) {
                throw new Error('Discord channel not found');
            }
        } catch (error: unknown) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Discord Channel Not Found')
                        .setDescription(
                            `Linking failed: Could not find Discord channel with ID \`${discordChannelId}\`.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error('Error fetching Discord channel:', error);
            return;
        }

        let discordWebhook;
        try {
            discordWebhook = await this.webhookService.createDiscordWebhook(
                discordChannelId,
                `Fluxer Bridge Webhook for channel ${message.channelId}`
            );
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Creating Discord Webhook')
                        .setDescription(
                            `Failed to create Discord webhook: ${errorMessage}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error('Error creating Discord webhook:', error);
            return;
        }

        let fluxerWebhook;
        try {
            fluxerWebhook = await this.webhookService.createFluxerWebhook(
                message.channelId,
                `Discord Bridge Webhook for channel ${message.channelId}`
            );
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Creating Fluxer Webhook')
                        .setDescription(
                            `Failed to create Fluxer webhook: ${errorMessage}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
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
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Channel Linked')
                        .setDescription(
                            `Successfully linked this Fluxer channel to Discord channel ID \`${discordChannelId}\`.`
                        )
                        .setColor(EmbedColors.Success)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Creating Channel Link')
                        .setDescription(
                            `Failed to create channel link: ${errorMessage}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error('Error creating channel link:', error);
        }
    }
}

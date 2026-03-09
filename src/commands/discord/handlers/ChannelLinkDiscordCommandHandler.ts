import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { WebhookService } from '../../../services/WebhookService';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import { EmbedColors } from '../../../utils/embeds';

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
        const footer = this.footer(message);

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

        let guildLink;
        try {
            guildLink = await this.linkService.getGuildLinkForDiscordGuild(
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
                'Failed fetching guild link for Discord channel link command',
                {
                    command,
                    discordGuildId: message.guildId,
                    discordChannelId: message.channelId,
                    fluxerChannelId,
                },
                error
            );
            return;
        }

        try {
            const c = await this.fluxerEntityResolver.fetchChannel(
                guildLink.fluxerGuildId,
                fluxerChannelId
            );
            if (!c) throw new Error('Channel not found');
        } catch (error: unknown) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Channel Not Found')
                        .setDescription(
                            `Linking failed: Could not find Fluxer channel with ID \`${fluxerChannelId}\`.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error('Error fetching Fluxer channel:', error);
            return;
        }

        let discordWebhook;
        try {
            discordWebhook = await this.webhookService.createDiscordWebhook(
                message.channelId,
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
                fluxerChannelId,
                `Discord Bridge Webhook for channel ${fluxerChannelId}`
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
                guildLinkId: guildLink!.id,
                discordChannelId: message.channelId,
                fluxerChannelId,
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
                            `Successfully linked this Discord channel to Fluxer channel ID \`${fluxerChannelId}\`.`
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

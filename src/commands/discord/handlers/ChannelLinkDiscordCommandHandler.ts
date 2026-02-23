import { getUsageMessage } from '../../../utils/usageMessage';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { Client, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { WebhookService } from '../../../services/WebhookService';

export default class ChannelLinkDiscordCommandHandler extends DiscordCommandHandler {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;

    constructor(client: Client, linkService: LinkService, webhookService: WebhookService) {
        super(client);
        this.linkService = linkService;
        this.webhookService = webhookService;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const member = await message.guild?.members.fetch(message.author.id);
        if (!member) {
            await message.reply('Could not fetch your member information.');
            return;
        }

        if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            await message.reply('You need the `Manage Channels` permission to use this command.');
            return;
        }

        if (args.length < 1 || args[0] === 'help') {
            const usage = getUsageMessage(
                command,
                ['<fluxer-channel-id>'],
                'Links the current Discord channel to a Fluxer channel.'
            );
            await message.reply(usage);
            return;
        }

        const fluxerChannelId = args[0];

        let guildLink = null;
        try {
            guildLink = await this.linkService.getGuildLinkForDiscordGuild(message.guildId!);
            if (!guildLink) {
                throw new Error('Guild not linked');
            }
        } catch (error: any) {
            await message.reply(`Failed to get guild link: ${error.message}`);
            logger.error('Error fetching guild link:', error);
            return;
        }

        let discordWebhook = null;
        try {
            discordWebhook = await this.webhookService.createDiscordWebhook(
                message.channelId,
                `Fluxer Bridge Webhook for channel ${message.channelId}`
            );
        } catch (error: any) {
            await message.reply(`Failed to create Discord webhook: ${error.message}`);
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
            await message.reply(`Failed to create Fluxer webhook: ${error.message}`);
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
                `Successfully linked this Discord channel to Fluxer channel ID \`${fluxerChannelId}\`.`
            );
        } catch (error: any) {
            await message.reply(`Failed to create channel link: ${error.message}`);
            logger.error('Error creating channel link:', error);
        }
    }
}

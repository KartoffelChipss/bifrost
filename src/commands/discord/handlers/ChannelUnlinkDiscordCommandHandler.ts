import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

export default class ChannelUnlinkDiscordCommandHandler extends DiscordCommandHandler {
    private readonly linkService: LinkService;

    constructor(client: Client, linkService: LinkService) {
        super(client);
        this.linkService = linkService;
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

        if (args.length > 0 && args[0].toLowerCase() === 'help') {
            const usage = getDiscordCommandUsage(command);
            await message.reply(usage);
            return;
        }

        try {
            await this.linkService.removeChannelLinkForDiscord(
                message.guildId!,
                message.channelId
            );
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Channel Unlinked')
                        .setDescription('Successfully unlinked channel link.')
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
                        .setTitle('Failed to Unlink Channel')
                        .setDescription(
                            'An error occurred while unlinking the channel: **' +
                                errorMessage +
                                '**'
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error(
                'Failed unlinking channel from Discord command',
                {
                    discordGuildId: message.guildId,
                    command,
                    discordChannelId: message.channelId,
                },
                error
            );
        }
    }
}

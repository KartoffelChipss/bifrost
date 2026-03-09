import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

export default class GuildUnlinkDiscordCommandHandler extends DiscordCommandHandler {
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
        const discordGuildId = message.guildId!;

        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageGuild,
            'Manage Guild'
        );
        if (!hasPerms) return;

        if (args.length > 0 && args[0].toLowerCase() === 'help') {
            const usage = getDiscordCommandUsage(command);
            await message.reply(usage);
            return;
        }

        try {
            await this.linkService.removeGuildLinkFromDiscord(discordGuildId);
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Guild Unlinked')
                        .setDescription(
                            'Successfully unlinked this Discord guild from its linked Fluxer guild.'
                        )
                        .setColor(EmbedColors.Success)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
        } catch (error: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Unlinking Guild')
                        .setDescription(`Failed to unlink guild: ${error.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error(
                'Failed unlinking guild from Discord command',
                {
                    command,
                    discordGuildId,
                },
                error
            );
        }
    }
}

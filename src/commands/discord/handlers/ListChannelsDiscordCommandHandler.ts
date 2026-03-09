import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import logger from '../../../utils/logging/logger';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

export default class ListChannelsDiscordCommandHandler extends DiscordCommandHandler {
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

        try {
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

            const channelLinks =
                await this.linkService.getChannelLinksForDiscordGuild(
                    message.guildId!
                );

            if (channelLinks.length === 0) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                'No channel links found for this guild.'
                            )
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }

            const linksList = channelLinks
                .map(
                    (link) =>
                        `• Discord: <#${link.discordChannelId}> <-> Fluxer: \`${link.fluxerChannelId}\` (Link ID: \`${link.linkId}\`)`
                )
                .join('\n');

            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Linked Channels')
                        .setDescription(linksList)
                        .setColor(EmbedColors.Info)
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
                        .setDescription(
                            `Failed to list channel links: ${errorMessage}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error(
                'Failed listing channel links for Discord guild',
                {
                    command,
                    discordGuildId: message.guildId,
                    discordChannelId: message.channelId,
                },
                error
            );
        }
    }
}

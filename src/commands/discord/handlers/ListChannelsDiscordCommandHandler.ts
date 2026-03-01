import { Client, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import logger from '../../../utils/logging/logger';
import { getCommandUsage } from '../../../commands/commandList';

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
        try {
            const hasPerms = await this.requirePermission(
                message,
                PermissionFlagsBits.ManageChannels,
                'Manage Channels'
            );
            if (!hasPerms) return;

            if (args.length > 0 && args[0].toLowerCase() === 'help') {
                const usage = getCommandUsage(command, 'discord');
                await message.reply(usage);
                return;
            }

            const channelLinks = await this.linkService.getChannelLinksForDiscordGuild(
                message.guildId!
            );

            if (channelLinks.length === 0) {
                await message.reply('No channel links found for this guild.');
                return;
            }

            const linksList = channelLinks
                .map(
                    (link) =>
                        `• Discord: <#${link.discordChannelId}> <-> Fluxer: \`${link.fluxerChannelId}\` (Link ID: \`${link.linkId}\`)`
                )
                .join('\n');

            await message.reply(`**Linked Channels:**\n${linksList}`);
        } catch (error: any) {
            await message.reply(`Failed to list channel links: ${error.message}`);
            logger.error('Error listing channel links: ', error);
        }
    }
}

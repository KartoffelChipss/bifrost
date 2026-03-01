import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { Client, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { getCommandUsage } from '../../../commands/commandList';

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
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageChannels,
            'Manage Channels'
        );
        if (!hasPerms) return;

        if (args.length < 1 || args[0].toLowerCase() === 'help') {
            const usage = getCommandUsage(command, 'discord');
            await message.reply(usage);
            return;
        }

        const linkId = args[0];

        try {
            await this.linkService.removeChannelLinkForDiscord(message.guildId!, linkId);
            await message.reply(`Successfully unlinked channel link \`${linkId}\`.`);
        } catch (error: any) {
            await message.reply(`Failed to unlink channel: ${error.message}`);
            logger.error('Error unlinking channel:', error);
        }
    }
}

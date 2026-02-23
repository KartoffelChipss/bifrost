import { getUsageMessage } from '../../../utils/usageMessage';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { Client, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';

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
                ['<link-id>'],
                'Unlinks a channel link. Get the link ID from the listchannels command.'
            );
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

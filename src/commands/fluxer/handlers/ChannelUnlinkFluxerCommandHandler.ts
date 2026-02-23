import { Client, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getUsageMessage } from '../../../utils/usageMessage';
import logger from '../../../utils/logging/logger';

export default class ChannelUnlinkFluxerCommandHandler extends FluxerCommandHandler {
    private readonly linkService: LinkService;

    constructor(client: Client, linkService: LinkService) {
        super(client);
        this.linkService = linkService;
    }

    public async handleCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const authorMember = await message.guild?.fetchMember(message.author.id);
        if (!authorMember) {
            await message.reply('Could not fetch your member information.');
            return;
        }

        if (!authorMember.permissions.has(PermissionFlags.ManageGuild)) {
            await message.reply('You need the `Manage Guild` permission to use this command.');
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
            await this.linkService.removeChannelLinkForFluxer(message.guildId!, linkId);
            await message.reply(`Successfully unlinked channel link \`${linkId}\`.`);
        } catch (error: any) {
            await message.reply(`Failed to unlink channel: ${error.message}`);
            logger.error('Error unlinking channel:', error);
        }
    }
}

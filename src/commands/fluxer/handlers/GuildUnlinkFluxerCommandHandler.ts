import { Client, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { getCommandUsage } from '../../../commands/commandList';

export default class GuildUnlinkFluxerCommandHandler extends FluxerCommandHandler {
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
        const fluxerGuildId = message.guildId!;

        const hasPerms = await this.requirePermission(
            message,
            PermissionFlags.ManageGuild,
            'Manage Guild'
        );
        if (!hasPerms) return;

        if (args.length > 0 && args[0].toLowerCase() === 'help') {
            const usage = getCommandUsage(command, 'fluxer');
            await message.reply(usage);
            return;
        }

        try {
            await this.linkService.removeGuildLinkFromFluxer(fluxerGuildId);
            await message.reply(`Successfully unlinked guild \`${fluxerGuildId}\`.`);
        } catch (error: any) {
            await message.reply(`Failed to unlink guild: ${error.message}`);
            logger.error('Error unlinking guild:', error);
        }
    }
}

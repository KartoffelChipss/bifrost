import { Client, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { getCommandUsage } from '../../../commands/commandList';

export default class ListChannelsFluxerCommandHandler extends FluxerCommandHandler {
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
        try {
            const hasPerms = await this.requirePermission(
                message,
                PermissionFlags.ManageChannels,
                'Manage Channels'
            );
            if (!hasPerms) return;

            if (args.length > 0 && args[0].toLowerCase() === 'help') {
                const usage = getCommandUsage(command, 'fluxer');
                await message.reply(usage);
                return;
            }

            const channelLinks = await this.linkService.getChannelLinksForFluxerGuild(
                message.guildId!
            );

            if (channelLinks.length === 0) {
                await message.reply('No channel links found for this guild.');
                return;
            }

            const linksList = channelLinks
                .map(
                    (link) =>
                        `• Fluxer: <#${link.fluxerChannelId}> <-> Discord: \`${link.discordChannelId}\` (Link ID: \`${link.linkId}\`)`
                )
                .join('\n');

            await message.reply(`**Linked Channels:**\n${linksList}`);
        } catch (error: any) {
            await message.reply(`Failed to list channel links: ${error.message}`);
            logger.error('Error listing channel links:', error);
        }
    }
}

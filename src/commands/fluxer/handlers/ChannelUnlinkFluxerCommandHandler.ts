import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { getFluxerCommandUsage } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

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
        const footer = this.footer(message);

        const hasPerms = await this.requirePermission(
            message,
            PermissionFlags.ManageChannels,
            'Manage Channels'
        );
        if (!hasPerms) return;

        if (args.length > 0 && args[0].toLowerCase() === 'help') {
            const usage = getFluxerCommandUsage(command);
            await message.reply(usage);
            return;
        }

        try {
            await this.linkService.removeChannelLinkForFluxer(
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
                            'An error occurred while unlinking the channel: ' +
                                errorMessage
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error(
                'Failed unlinking channel from Fluxer command',
                {
                    fluxerChannelId: message.channelId,
                    command,
                    fluxerGuildId: message.guildId,
                },
                error
            );
        }
    }
}

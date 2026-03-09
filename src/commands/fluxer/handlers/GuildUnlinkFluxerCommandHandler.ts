import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { getFluxerCommandUsage } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

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
        const footer = this.footer(message);
        const fluxerGuildId = message.guildId!;

        const hasPerms = await this.requirePermission(
            message,
            PermissionFlags.ManageGuild,
            'Manage Guild'
        );
        if (!hasPerms) return;

        if (args.length > 0 && args[0].toLowerCase() === 'help') {
            const usage = getFluxerCommandUsage(command);
            await message.reply(usage);
            return;
        }

        try {
            await this.linkService.removeGuildLinkFromFluxer(fluxerGuildId);
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Guild Unlinked')
                        .setDescription(
                            'Successfully unlinked this Fluxer guild from its linked Discord guild.'
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
                'Failed unlinking guild from Fluxer command',
                {
                    command,
                },
                fluxerGuildId,
                error
            );
        }
    }
}

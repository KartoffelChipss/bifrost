import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { getFluxerCommandUsage } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

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
        const footer = this.footer(message);

        try {
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

            const channelLinks = await this.linkService.getChannelLinksForFluxerGuild(
                message.guildId!
            );

            if (channelLinks.length === 0) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No channel links found for this guild.')
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer).setTimestamp(),
                    ],
                });
                return;
            }

            const linksList = channelLinks
                .map(
                    (link) =>
                        `• Fluxer: <#${link.fluxerChannelId}> <-> Discord: \`${link.discordChannelId}\` (Link ID: \`${link.linkId}\`)`
                )
                .join('\n');

            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Linked Channels')
                        .setDescription(linksList)
                        .setColor(EmbedColors.Info)
                        .setFooter(footer).setTimestamp(),
                ],
            });
        } catch (error: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`Failed to list channel links: ${error.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            logger.error(
                'Failed listing channel links for Fluxer guild',
                {
                    command,
                    fluxerGuildId: message.guildId,
                    fluxerChannelId: message.channelId,
                },
                error
            );
        }
    }
}

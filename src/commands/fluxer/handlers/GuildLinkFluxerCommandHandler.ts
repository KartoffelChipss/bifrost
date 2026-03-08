import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { LinkService } from '../../../services/LinkService';
import logger from '../../../utils/logging/logger';
import { getFluxerCommandUsage } from '../../../commands/commandList';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import { EmbedColors } from '../../../utils/embeds';

export default class GuildLinkFluxerCommandHandler extends FluxerCommandHandler {
    private readonly linkService: LinkService;
    private readonly discordEntityResolver: DiscordEntityResolver;

    constructor(
        client: Client,
        linkService: LinkService,
        discordEntityResolver: DiscordEntityResolver
    ) {
        super(client);
        this.linkService = linkService;
        this.discordEntityResolver = discordEntityResolver;
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

        if (args.length < 1 || args[0].toLowerCase() === 'help') {
            const usage = getFluxerCommandUsage(command);
            await message.reply(usage);
            return;
        }

        const [rawGuildId] = args;
        const discordGuildId = rawGuildId.replace(/^<|>$/g, '');

        try {
            const discordGuild = await this.discordEntityResolver.fetchGuild(discordGuildId);
            if (!discordGuild) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Guild Not Found')
                            .setDescription(`Could not find Discord guild with ID \`${discordGuildId}\`.`)
                            .setColor(EmbedColors.Error)
                            .setFooter(footer).setTimestamp(),
                    ],
                });
                return;
            }
        } catch (error: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Verifying Guild')
                        .setDescription(`Failed to verify Discord guild: ${error.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            logger.error(
                'Failed verifying Discord guild for Fluxer guild link command',
                {
                    command,
                    fluxerGuildId,
                    discordGuildId,
                },
                error
            );
            return;
        }

        try {
            await this.linkService.createGuildLink(discordGuildId, fluxerGuildId);
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Guild Linked')
                        .setDescription(`Successfully linked Discord guild \`${discordGuildId}\` with Fluxer guild \`${fluxerGuildId}\`.`)
                        .setColor(EmbedColors.Success)
                        .setFooter(footer).setTimestamp(),
                ],
            });
        } catch (error: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Creating Guild Link')
                        .setDescription(`Failed to create guild link: ${error.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            logger.error('Error creating guild link:', error);
        }
    }
}

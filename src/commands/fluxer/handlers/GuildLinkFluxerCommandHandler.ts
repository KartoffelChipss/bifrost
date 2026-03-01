import { Client, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { LinkService } from '../../../services/LinkService';
import logger from '../../../utils/logging/logger';
import { getCommandUsage } from '../../../commands/commandList';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';

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
        const fluxerGuildId = message.guildId!;

        const hasPerms = await this.requirePermission(
            message,
            PermissionFlags.ManageGuild,
            'Manage Guild'
        );
        if (!hasPerms) return;

        if (args.length < 1 || args[0].toLowerCase() === 'help') {
            const usage = getCommandUsage(command, 'fluxer');
            await message.reply(usage);
            return;
        }

        const [discordGuildId] = args;

        try {
            const discordGuild = await this.discordEntityResolver.fetchGuild(discordGuildId);
            if (!discordGuild) {
                await message.reply(
                    `Linking failed: Could not find Discord guild with ID \`${discordGuildId}\`.`
                );
                return;
            }
        } catch (error: any) {
            await message.reply(`Failed to verify Discord guild: ${error.message}`);
            logger.error('Error fetching Discord guild:', error);
            return;
        }

        try {
            const guildLink = await this.linkService.createGuildLink(discordGuildId, fluxerGuildId);
            await message.reply(
                `Successfully linked Discord guild \`${discordGuildId}\` with Fluxer guild \`${fluxerGuildId}\`. Link ID: \`${guildLink.id}\``
            );
        } catch (error: any) {
            await message.reply(`Failed to create guild link: ${error.message}`);
            logger.error('Error creating guild link:', error);
        }
    }
}

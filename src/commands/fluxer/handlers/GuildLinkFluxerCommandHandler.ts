import { Client, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { LinkService } from '../../../services/LinkService';
import logger from '../../../utils/logging/logger';
import { getFluxerCommandUsage } from '../../../commands/commandList';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import { createFluxerErrorReply, createFluxerSuccessReply } from '../../../utils/embeds';

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
            const usage = getFluxerCommandUsage(command);
            await message.reply(usage);
            return;
        }

        const [rawGuildId] = args;
        const discordGuildId = rawGuildId.replace(/^<|>$/g, '');

        try {
            const discordGuild = await this.discordEntityResolver.fetchGuild(discordGuildId);
            if (!discordGuild) {
                await message.reply(
                    createFluxerErrorReply(
                        `Could not find Discord guild with ID \`${discordGuildId}\`.`,
                        'Guild Not Found'
                    )
                );
                return;
            }
        } catch (error: any) {
            await message.reply(
                createFluxerErrorReply(
                    `Failed to verify Discord guild: ${error.message}`,
                    'Error Verifying Guild'
                )
            );
            logger.error('Error fetching Discord guild:', error);
            return;
        }

        try {
            await this.linkService.createGuildLink(discordGuildId, fluxerGuildId);
            await message.reply(
                createFluxerSuccessReply(
                    `Successfully linked Discord guild \`${discordGuildId}\` with Fluxer guild \`${fluxerGuildId}\`.`,
                    'Guild Linked'
                )
            );
        } catch (error: any) {
            await message.reply(
                createFluxerErrorReply(
                    `Failed to create guild link: ${error.message}`,
                    'Error Creating Guild Link'
                )
            );
            logger.error('Error creating guild link:', error);
        }
    }
}

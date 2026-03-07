import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { Client, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import { createDiscordErrorReply, createDiscordSuccessReply } from '../../../utils/embeds';

export default class GuildLinkDiscordCommandHandler extends DiscordCommandHandler {
    private readonly linkService: LinkService;
    private readonly fluxerEntityResolver: FluxerEntityResolver;

    constructor(
        client: Client,
        linkService: LinkService,
        fluxerEntityResolver: FluxerEntityResolver
    ) {
        super(client);
        this.linkService = linkService;
        this.fluxerEntityResolver = fluxerEntityResolver;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const discordGuildId = message.guildId!;

        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageGuild,
            'Manage Guild'
        );
        if (!hasPerms) return;

        if (args.length < 1 || args[0].toLowerCase() === 'help') {
            const usage = getDiscordCommandUsage(command);
            await message.reply(usage);
            return;
        }

        const [rawGuildId] = args;
        const fluxerGuildId = rawGuildId.replace(/^<|>$/g, '');

        try {
            const fluxerGuild = await this.fluxerEntityResolver.fetchGuild(fluxerGuildId);
            if (!fluxerGuild) {
                await message.reply(
                    createDiscordErrorReply(
                        `Could not find Fluxer guild with ID \`${fluxerGuildId}\`.`,
                        'Fluxer Guild Not Found'
                    )
                );
                return;
            }
        } catch (error: any) {
            await message.reply(
                createDiscordErrorReply(
                    `Failed to verify Fluxer guild: ${error.message}`,
                    'Error Verifying Fluxer Guild'
                )
            );
            logger.error('Error fetching Fluxer guild:', error);
            return;
        }

        try {
            await this.linkService.createGuildLink(discordGuildId, fluxerGuildId);
            await message.reply(
                createDiscordSuccessReply(
                    `Successfully linked Discord guild \`${discordGuildId}\` with Fluxer guild \`${fluxerGuildId}\`.`,
                    'Guild Linked'
                )
            );
        } catch (error: any) {
            await message.reply(
                createDiscordErrorReply(
                    `Failed to create guild link: ${error.message}`,
                    'Error Creating Guild Link'
                )
            );
            logger.error('Error creating guild link:', error);
        }
    }
}

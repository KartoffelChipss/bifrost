import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { Client, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { getCommandUsage } from '../../../commands/commandList';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';

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
            const usage = getCommandUsage(command, 'discord');
            await message.reply(usage);
            return;
        }

        const [fluxerGuildId] = args;

        try {
            const fluxerGuild = await this.fluxerEntityResolver.fetchGuild(fluxerGuildId);
            if (!fluxerGuild) {
                await message.reply(
                    `Linking failed: Could not find Fluxer guild with ID \`${fluxerGuildId}\`.`
                );
                return;
            }
        } catch (error: any) {
            await message.reply(`Failed to verify Fluxer guild: ${error.message}`);
            logger.error('Error fetching Fluxer guild:', error);
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

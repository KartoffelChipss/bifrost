import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { Client, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { getCommandUsage } from '../../../commands/commandList';

export default class GuildLinkDiscordCommandHandler extends DiscordCommandHandler {
    private readonly linkService: LinkService;

    constructor(client: Client, linkService: LinkService) {
        super(client);
        this.linkService = linkService;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const discordGuildId = message.guildId!;

        const member = await message.guild?.members.fetch(message.author.id);
        if (!member) {
            await message.reply('Could not fetch your member information.');
            return;
        }

        if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            await message.reply('You need the `Manage Guild` permission to use this command.');
            return;
        }

        if (args.length < 1 || args[0].toLowerCase() === 'help') {
            const usage = getCommandUsage(command, 'discord');
            await message.reply(usage);
            return;
        }

        const [fluxerGuildId] = args;

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

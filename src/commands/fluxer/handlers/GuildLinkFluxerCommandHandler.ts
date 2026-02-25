import { Client, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { LinkService } from '../../../services/LinkService';
import logger from '../../../utils/logging/logger';
import { getCommandUsage } from '../../../commands/commandList';

export default class GuildLinkFluxerCommandHandler extends FluxerCommandHandler {
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
        const fluxerGuildId = message.guildId!;

        const authorMember = await message.guild?.fetchMember(message.author.id);
        if (!authorMember) {
            await message.reply('Could not fetch your member information.');
            return;
        }

        if (!authorMember.permissions.has(PermissionFlags.ManageGuild)) {
            await message.reply('You need the `Manage Guild` permission to use this command.');
            return;
        }

        if (args.length < 1 || args[0].toLowerCase() === 'help') {
            const usage = getCommandUsage(command, 'fluxer');
            await message.reply(usage);
            return;
        }

        const [discordGuildId] = args;

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

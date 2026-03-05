import { Client } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import logger from '../../../utils/logging/logger';

export default class ListDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService
    ) {
        super(client);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ..._args: string[]
    ): Promise<void> {
        const isOwner = await this.requireOwner(message);
        if (!isOwner) return;

        try {
            const channelLinks = await this.linkService.getChannelLinksForDiscordGuild(
                message.guildId!
            );

            if (channelLinks.length === 0) {
                await message.reply('No channel links found for this server.');
                return;
            }

            const lines = channelLinks.map(
                (link) =>
                    `• <#${link.discordChannelId}> ↔ \`${link.fluxerChannelId}\` (Fluxer) — ID: \`${link.linkId}\``
            );

            await message.reply(`**Linked Channels:**\n${lines.join('\n')}`);
        } catch (err: any) {
            await message.reply(`Failed to list channel links: ${err.message}`);
            logger.error('Error listing channel links:', err);
        }
    }
}

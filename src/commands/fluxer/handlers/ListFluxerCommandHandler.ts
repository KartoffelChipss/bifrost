import { Client, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';

export default class ListFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService
    ) {
        super(client);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ..._args: string[]
    ): Promise<void> {
        const isOwner = await this.requireOwner(message);
        if (!isOwner) return;

        try {
            const channelLinks = await this.linkService.getChannelLinksForFluxerGuild(
                message.guildId!
            );

            if (channelLinks.length === 0) {
                await message.reply('No channel links found for this server.');
                return;
            }

            const lines = channelLinks.map(
                (link) =>
                    `• <#${link.fluxerChannelId}> ↔ \`${link.discordChannelId}\` (Discord) — ID: \`${link.linkId}\``
            );

            await message.reply(`**Linked Channels:**\n${lines.join('\n')}`);
        } catch (err: any) {
            await message.reply(`Failed to list channel links: ${err.message}`);
            logger.error('Error listing channel links:', err);
        }
    }
}

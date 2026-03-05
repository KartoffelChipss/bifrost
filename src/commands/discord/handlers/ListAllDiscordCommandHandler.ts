import { Client } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import logger from '../../../utils/logging/logger';

export default class ListAllDiscordCommandHandler extends DiscordCommandHandler {
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
            const guildLinks = await this.linkService.getAllGuildLinks();

            if (guildLinks.length === 0) {
                await message.reply('No guild bridges configured.');
                return;
            }

            const sections: string[] = [];

            for (const guildLink of guildLinks) {
                const channelLinks = await this.linkService.getChannelLinksForDiscordGuild(
                    guildLink.discordGuildId
                );
                const header = `**Guild Bridge:** Discord \`${guildLink.discordGuildId}\` ↔ Fluxer \`${guildLink.fluxerGuildId}\``;
                if (channelLinks.length === 0) {
                    sections.push(`${header}\n  *(no channel links)*`);
                } else {
                    const lines = channelLinks.map(
                        (link) =>
                            `  • <#${link.discordChannelId}> ↔ \`${link.fluxerChannelId}\` — ID: \`${link.linkId}\``
                    );
                    sections.push(`${header}\n${lines.join('\n')}`);
                }
            }

            await message.reply(sections.join('\n\n'));
        } catch (err: any) {
            await message.reply(`Failed to list all links: ${err.message}`);
            logger.error('Error listing all links:', err);
        }
    }
}

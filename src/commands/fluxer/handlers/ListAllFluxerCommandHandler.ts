import { Client, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';

export default class ListAllFluxerCommandHandler extends FluxerCommandHandler {
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((message.guild as any)?.ownerId !== message.author.id) {
            await message.reply('Only the server owner can use this command.');
            return;
        }

        try {
            const guildLinks = await this.linkService.getAllGuildLinks();

            if (guildLinks.length === 0) {
                await message.reply('No guild bridges configured.');
                return;
            }

            const sections: string[] = [];

            for (const guildLink of guildLinks) {
                const channelLinks = await this.linkService.getChannelLinksForFluxerGuild(
                    guildLink.fluxerGuildId
                );
                const header = `**Guild Bridge:** Fluxer \`${guildLink.fluxerGuildId}\` ↔ Discord \`${guildLink.discordGuildId}\``;
                if (channelLinks.length === 0) {
                    sections.push(`${header}\n  *(no channel links)*`);
                } else {
                    const lines = channelLinks.map(
                        (link) =>
                            `  • <#${link.fluxerChannelId}> ↔ \`${link.discordChannelId}\` — ID: \`${link.linkId}\``
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

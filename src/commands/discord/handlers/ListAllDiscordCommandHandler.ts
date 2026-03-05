import { Client, EmbedBuilder } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

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
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No guild bridges configured.')
                            .setColor(EmbedColors.Warning)
                            .setFooter({ text: `${message.content} | ${message.author.tag}` })
                    ]
                });
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

            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('All Guild Bridges')
                        .setDescription(sections.join('\n\n'))
                        .setColor(EmbedColors.Info)
                        .setFooter({ text: `${message.content} | ${message.author.tag}` })
                ]
            });
        } catch (err: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`Failed to list all links: ${err.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter({ text: `${message.content} | ${message.author.tag}` })
                ]
            });
            logger.error('Error listing all links:', err);
        }
    }
}

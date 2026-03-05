import { Client, EmbedBuilder } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

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
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No channel links found for this server.')
                            .setColor(EmbedColors.Warning)
                            .setFooter({ text: `${message.content} | ${message.author.tag}` })
                    ]
                });
                return;
            }

            const lines = channelLinks.map(
                (link) =>
                    `• <#${link.discordChannelId}> ↔ \`${link.fluxerChannelId}\` (Fluxer) — ID: \`${link.linkId}\``
            );

            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Linked Channels')
                        .setDescription(lines.join('\n'))
                        .setColor(EmbedColors.Info)
                        .setFooter({ text: `${message.content} | ${message.author.tag}` })
                ]
            });
        } catch (err: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`Failed to list channel links: ${err.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter({ text: `${message.content} | ${message.author.tag}` })
                ]
            });
            logger.error('Error listing channel links:', err);
        }
    }
}

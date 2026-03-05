import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

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
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No channel links found for this server.')
                            .setColor(EmbedColors.Warning)
                            .setFooter({ text: `${message.content} | ${message.author.username}#${message.author.discriminator}` }),
                    ],
                });
                return;
            }

            const lines = channelLinks.map(
                (link) =>
                    `• <#${link.fluxerChannelId}> ↔ \`${link.discordChannelId}\` (Discord) — ID: \`${link.linkId}\``
            );

            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Linked Channels')
                        .setDescription(lines.join('\n'))
                        .setColor(EmbedColors.Info)
                        .setFooter({ text: `${message.content} | ${message.author.username}#${message.author.discriminator}` }),
                ],
            });
        } catch (err: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`Failed to list channel links: ${err.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter({ text: `${message.content} | ${message.author.username}#${message.author.discriminator}` }),
                ],
            });
            logger.error('Error listing channel links:', err);
        }
    }
}

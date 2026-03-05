import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';
import { FLUX_USERID } from '../../../utils/env';

export default class ListFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly discordEntityResolver: DiscordEntityResolver
    ) {
        super(client);
    }

    private async buildChannelLines(
        channelLinks: { fluxerChannelId: string; discordChannelId: string; linkId: string }[],
        discordGuildId: string,
        showLinkId = false
    ): Promise<string[]> {
        return Promise.all(
            channelLinks.map(async (link) => {
                const discordChannel = await this.discordEntityResolver
                    .fetchChannel(discordGuildId, link.discordChannelId)
                    .catch(() => null);
                const discordName = (discordChannel as any)?.name ?? link.discordChannelId;
                const discordUrl = `https://discord.com/channels/${discordGuildId}/${link.discordChannelId}`;
                const suffix = showLinkId ? ` | \`${link.linkId}\`` : '';
                return `<#${link.fluxerChannelId}> ←→ [#${discordName}](${discordUrl})${suffix}\n  └ \`${link.fluxerChannelId}\` · \`${link.discordChannelId}\``;
            })
        );
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const isOwner = await this.requireOwner(message);
        if (!isOwner) return;

        if (args[0]?.toLowerCase() === 'all') {
            if (!FLUX_USERID || message.author.id !== FLUX_USERID) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('You do not have permission to use this command.')
                            .setColor(EmbedColors.Error)
                            .setFooter({ text: `${message.content} | ${message.author.username}#${message.author.discriminator}` }),
                    ],
                });
                return;
            }

            try {
                const guildLinks = await this.linkService.getAllGuildLinks();

                if (guildLinks.length === 0) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription('No guild bridges configured.')
                                .setColor(EmbedColors.Warning)
                                .setFooter({ text: `${message.content} | ${message.author.username}#${message.author.discriminator}` }),
                        ],
                    });
                    return;
                }

                const embeds: EmbedBuilder[] = [];

                for (const guildLink of guildLinks) {
                    const [channelLinks, discordGuild, fluxerGuild] = await Promise.all([
                        this.linkService.getChannelLinksForFluxerGuild(guildLink.fluxerGuildId),
                        this.discordEntityResolver.fetchGuild(guildLink.discordGuildId).catch(() => null),
                        this.getClient().guilds.fetch(guildLink.fluxerGuildId).catch(() => null),
                    ]);

                    const discordGuildName = (discordGuild as any)?.name ?? guildLink.discordGuildId;
                    const fluxerGuildName = (fluxerGuild as any)?.name ?? guildLink.fluxerGuildId;
                    const title = `Fluxer: ${fluxerGuildName} (${guildLink.fluxerGuildId}) | Discord: ${discordGuildName} (${guildLink.discordGuildId})`;

                    let description: string;
                    if (channelLinks.length === 0) {
                        description = '*(no channel links)*';
                    } else {
                        const lines = await this.buildChannelLines(channelLinks, guildLink.discordGuildId, true);
                        description = lines.join('\n\n');
                    }

                    embeds.push(
                        new EmbedBuilder()
                            .setTitle(title)
                            .setDescription(description)
                            .setColor(EmbedColors.Info)
                    );
                }

                embeds[embeds.length - 1].setFooter({
                    text: `${message.content} | ${message.author.username}#${message.author.discriminator}`,
                });

                await message.reply({ embeds });
            } catch (err: any) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`Failed to list all links: ${err.message}`)
                            .setColor(EmbedColors.Error)
                            .setFooter({ text: `${message.content} | ${message.author.username}#${message.author.discriminator}` }),
                    ],
                });
                logger.error('Error listing all links:', err);
            }
            return;
        }

        try {
            const guildLink = await this.linkService.getGuildLinkForFluxerGuild(message.guildId!);

            if (!guildLink) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No guild bridge found for this server.')
                            .setColor(EmbedColors.Warning)
                            .setFooter({ text: `${message.content} | ${message.author.username}#${message.author.discriminator}` }),
                    ],
                });
                return;
            }

            const channelLinks = await this.linkService.getChannelLinksForFluxerGuild(message.guildId!);

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

            const lines = await this.buildChannelLines(channelLinks, guildLink.discordGuildId);

            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Fluxer ↔ Discord | Linked Channels')
                        .setDescription(lines.join('\n\n'))
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

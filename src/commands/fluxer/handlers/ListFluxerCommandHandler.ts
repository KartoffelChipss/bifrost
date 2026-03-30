import { Client, EmbedBuilder, Message, PermissionsBitField } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';
import { FLUXER_OWNER_ID } from '../../../utils/env';

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
        const footer = this.footer(message);

        if (args[0]?.toLowerCase() === 'all') {
            if (!FLUXER_OWNER_ID || message.author.id !== FLUXER_OWNER_ID) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('You do not have permission to use this command.')
                            .setColor(EmbedColors.Error)
                            .setFooter(footer).setTimestamp(),
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
                                .setFooter(footer).setTimestamp(),
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

                embeds[embeds.length - 1].setFooter(footer).setTimestamp();

                if (!message.guildId) {
                    await message.reply({ embeds });
                } else {
                    try {
                        const dm = await (message.author as any).createDM?.();
                        if (!dm) throw new Error('DM not supported');
                        await dm.send({ embeds });
                    } catch {
                        await message.reply({
                            embeds: [
                                new EmbedBuilder()
                                    .setDescription('Could not send DM — ensure your DMs are open.')
                                    .setColor(EmbedColors.Error)
                                    .setFooter(footer).setTimestamp(),
                            ],
                        });
                        logger.error('Failed to DM %list all output to Fluxer user:', message.author.id);
                    }
                }
            } catch (err: any) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`Failed to list all links: ${err.message}`)
                            .setColor(EmbedColors.Error)
                            .setFooter(footer).setTimestamp(),
                    ],
                });
                logger.error('Error listing all links:', err);
            }
            return;
        }

        if (!message.guildId) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription('This command must be used in a server.')
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            return;
        }

        if (!await this.requirePermission(message, PermissionsBitField.Flags.ManageWebhooks, 'Manage Webhooks')) return;

        try {
            const guildLink = await this.linkService.getGuildLinkForFluxerGuild(message.guildId!);

            if (!guildLink) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No guild bridge found for this server.')
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer).setTimestamp(),
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
                            .setFooter(footer).setTimestamp(),
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
                        .setFooter(footer).setTimestamp(),
                ],
            });
        } catch (err: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`Failed to list channel links: ${err.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            logger.error('Error listing channel links:', err);
        }
    }
}

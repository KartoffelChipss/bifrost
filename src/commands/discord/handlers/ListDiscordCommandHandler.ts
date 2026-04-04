import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';
import { DISCORD_OWNER_ID } from '../../../utils/env';

export default class ListDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly fluxerEntityResolver: FluxerEntityResolver
    ) {
        super(client);
    }

    private async buildChannelLines(
        channelLinks: { fluxerChannelId: string; discordChannelId: string; linkId: string }[],
        fluxerGuildId: string,
        showLinkId = false
    ): Promise<string[]> {
        return Promise.all(
            channelLinks.map(async (link) => {
                const fluxerChannel = await this.fluxerEntityResolver
                    .fetchChannel(fluxerGuildId, link.fluxerChannelId)
                    .catch(() => null);
                const fluxerName =
                    (fluxerChannel as { name?: string } | null)?.name ??
                    link.fluxerChannelId;
                const fluxerUrl = `https://fluxer.app/channels/${fluxerGuildId}/${link.fluxerChannelId}`;
                const suffix = showLinkId ? ` | \`${link.linkId}\`` : '';
                // Discord on left, Fluxer on right (viewing from Discord)
                return `<#${link.discordChannelId}> ←→ [#${fluxerName}](${fluxerUrl})${suffix}\n  └ \`${link.discordChannelId}\` · \`${link.fluxerChannelId}\``;
            })
        );
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        if (args[0]?.toLowerCase() === 'all') {
            if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('You do not have permission to use this command.')
                            .setColor(EmbedColors.Error)
                            .setFooter(footer).setTimestamp()
                    ]
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
                                .setFooter(footer).setTimestamp()
                        ]
                    });
                    return;
                }

                const embeds: EmbedBuilder[] = [];

                for (const guildLink of guildLinks) {
                    const [channelLinks, fluxerGuild, discordGuild] =
                        await Promise.all([
                            this.linkService.getChannelLinksForDiscordGuild(
                                guildLink.discordGuildId
                            ),
                            this.fluxerEntityResolver
                                .fetchGuild(guildLink.fluxerGuildId)
                                .catch(() => null),
                            this.getClient()
                                .guilds.fetch(guildLink.discordGuildId)
                                .catch(() => null),
                        ]);

                    const fluxerGuildName =
                        (fluxerGuild as { name?: string } | null)?.name ??
                        guildLink.fluxerGuildId;
                    const discordGuildName =
                        (discordGuild as { name?: string } | null)?.name ??
                        guildLink.discordGuildId;
                    const title = `Discord: ${discordGuildName} (${guildLink.discordGuildId}) | Fluxer: ${fluxerGuildName} (${guildLink.fluxerGuildId})`;

                    let description: string;
                    if (channelLinks.length === 0) {
                        description = '*(no channel links)*';
                    } else {
                        const lines = await this.buildChannelLines(
                            channelLinks,
                            guildLink.fluxerGuildId,
                            true
                        );
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

                if (!message.inGuild()) {
                    await message.reply({ embeds });
                } else {
                    try {
                        const dm = await message.author.createDM();
                        await dm.send({ embeds });
                    } catch {
                        await message.reply({
                            embeds: [
                                new EmbedBuilder()
                                    .setDescription(
                                        'Could not send DM — ensure your DMs are open.'
                                    )
                                    .setColor(EmbedColors.Error)
                                    .setFooter(footer)
                                    .setTimestamp(),
                            ],
                        });
                        logger.error(
                            'Failed to DM %list all output to Discord user:',
                            message.author.id
                        );
                    }
                }
            } catch (err: unknown) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Failed to list all links: ${(err as Error).message}`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                logger.error('Error listing all links:', err);
            }
            return;
        }

        if (!message.inGuild()) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription('This command must be used in a server.')
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp()
                ]
            });
            return;
        }

        if (!await this.requirePermission(message, PermissionFlagsBits.ManageWebhooks, 'Manage Webhooks')) return;

        try {
            const guildLink = await this.linkService.getGuildLinkForDiscordGuild(message.guildId!);

            if (!guildLink) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No guild bridge found for this server.')
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer).setTimestamp()
                    ]
                });
                return;
            }

            const channelLinks = await this.linkService.getChannelLinksForDiscordGuild(message.guildId!);

            if (channelLinks.length === 0) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No channel links found for this server.')
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer).setTimestamp()
                    ]
                });
                return;
            }

            const lines = await this.buildChannelLines(channelLinks, guildLink.fluxerGuildId);

            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Discord ↔ Fluxer | Linked Channels')
                        .setDescription(lines.join('\n\n'))
                        .setColor(EmbedColors.Info)
                        .setFooter(footer).setTimestamp()
                ]
            });
        } catch (err: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`Failed to list channel links: ${err.message}`)
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp()
                ]
            });
            logger.error('Error listing channel links:', err);
        }
    }
}

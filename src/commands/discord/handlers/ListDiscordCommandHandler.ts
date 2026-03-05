import { Client, EmbedBuilder } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';
import { DISCORD_USERID } from '../../../utils/env';

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
                const fluxerName = (fluxerChannel as any)?.name ?? link.fluxerChannelId;
                const fluxerUrl = `https://fluxer.app/channels/${fluxerGuildId}/${link.fluxerChannelId}`;
                const suffix = showLinkId ? ` | \`${link.linkId}\`` : '';
                return `[#${fluxerName}](${fluxerUrl}) ←→ <#${link.discordChannelId}>${suffix}\n  └ \`${link.fluxerChannelId}\` · \`${link.discordChannelId}\``;
            })
        );
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const isOwner = await this.requireOwner(message);
        if (!isOwner) return;

        if (args[0]?.toLowerCase() === 'all') {
            if (!DISCORD_USERID || message.author.id !== DISCORD_USERID) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('You do not have permission to use this command.')
                            .setColor(EmbedColors.Error)
                            .setFooter({ text: `${message.content} | ${message.author.tag}` })
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
                                .setFooter({ text: `${message.content} | ${message.author.tag}` })
                        ]
                    });
                    return;
                }

                const embeds: EmbedBuilder[] = [];

                for (const guildLink of guildLinks) {
                    const [channelLinks, fluxerGuild, discordGuild] = await Promise.all([
                        this.linkService.getChannelLinksForDiscordGuild(guildLink.discordGuildId),
                        this.fluxerEntityResolver.fetchGuild(guildLink.fluxerGuildId).catch(() => null),
                        this.getClient().guilds.fetch(guildLink.discordGuildId).catch(() => null),
                    ]);

                    const fluxerGuildName = (fluxerGuild as any)?.name ?? guildLink.fluxerGuildId;
                    const discordGuildName = (discordGuild as any)?.name ?? guildLink.discordGuildId;
                    const title = `Fluxer: ${fluxerGuildName} (${guildLink.fluxerGuildId}) | Discord: ${discordGuildName} (${guildLink.discordGuildId})`;

                    let description: string;
                    if (channelLinks.length === 0) {
                        description = '*(no channel links)*';
                    } else {
                        const lines = await this.buildChannelLines(channelLinks, guildLink.fluxerGuildId, true);
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
                    text: `${message.content} | ${message.author.tag}`,
                });

                await message.reply({ embeds });
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
            return;
        }

        try {
            const guildLink = await this.linkService.getGuildLinkForDiscordGuild(message.guildId!);

            if (!guildLink) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No guild bridge found for this server.')
                            .setColor(EmbedColors.Warning)
                            .setFooter({ text: `${message.content} | ${message.author.tag}` })
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
                            .setFooter({ text: `${message.content} | ${message.author.tag}` })
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

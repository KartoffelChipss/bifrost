import { ChannelType } from 'discord.js';
import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import { WebhookService } from '../../../services/WebhookService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import { matchChannels, ChannelInfo } from '../../../utils/channelMatcher';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

export default class AutolinkFluxerCommandHandler extends FluxerCommandHandler {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;
    private readonly discordEntityResolver: DiscordEntityResolver;

    constructor(
        client: Client,
        linkService: LinkService,
        webhookService: WebhookService,
        discordEntityResolver: DiscordEntityResolver
    ) {
        super(client);
        this.linkService = linkService;
        this.webhookService = webhookService;
        this.discordEntityResolver = discordEntityResolver;
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const isOwner = await this.requireOwner(message);
        if (!isOwner) return;

        const footer = this.footer(message);
        const doConfirm = args[0]?.toLowerCase() === 'confirm';

        let guildLink;
        try {
            guildLink = await this.linkService.getGuildLinkForFluxerGuild(message.guildId!);
            if (!guildLink) throw new Error('this guild is not linked to a Discord guild');
        } catch (error: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Cannot run autolink: ${error.message}. Use \`${COMMAND_PREFIX}linkguild\` first.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            return;
        }

        // Get already-linked channel IDs to skip them
        const existingLinks = await this.linkService.getChannelLinksForFluxerGuild(
            message.guildId!
        );
        const linkedDiscordIds = new Set(existingLinks.map((l) => l.discordChannelId));
        const linkedFluxerIds = new Set(existingLinks.map((l) => l.fluxerChannelId));

        // Fetch all Fluxer text channels in this guild
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allFluxerChannels: any[] = await (message.guild as any).fetchChannels();
        const fluxerTextChannels: ChannelInfo[] = allFluxerChannels
            .filter((ch: any) => ch.isTextBased() && !linkedFluxerIds.has(ch.id))
            .map((ch: any) => ({ id: ch.id, name: ch.name as string }));

        // Fetch all Discord text channels in the linked Discord guild
        const discordGuild = await this.discordEntityResolver.fetchGuild(guildLink.discordGuildId);
        if (!discordGuild) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription('Could not fetch the linked Discord guild.')
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            return;
        }
        const allDiscordChannels = await discordGuild.channels.fetch();
        const discordTextChannels: ChannelInfo[] = [];
        for (const [, ch] of allDiscordChannels) {
            if (ch && ch.type === ChannelType.GuildText && !linkedDiscordIds.has(ch.id)) {
                discordTextChannels.push({ id: ch.id, name: ch.name });
            }
        }

        const proposals = matchChannels(discordTextChannels, fluxerTextChannels);

        if (proposals.length === 0) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `No confident channel name matches found among **${discordTextChannels.length}** unlinked Discord` +
                                ` and **${fluxerTextChannels.length}** unlinked Fluxer text channels.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            return;
        }

        if (!doConfirm) {
            const lines = proposals.map(
                (p) =>
                    `> \`#${p.discord.name}\` ↔ \`#${p.fluxer.name}\` (${Math.round(p.score * 100)}% match)`
            );
            const unmatchedDiscord = discordTextChannels.length - proposals.length;
            const unmatchedFluxer = fluxerTextChannels.length - proposals.length;
            const unmatchedTotal = unmatchedDiscord + unmatchedFluxer;

            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Auto-link Wizard')
                        .setDescription(
                            [
                                `${proposals.length} proposal${proposals.length !== 1 ? 's' : ''} found`,
                                '',
                                lines.join('\n'),
                                '',
                                unmatchedTotal > 0
                                    ? `${unmatchedTotal} channel${unmatchedTotal !== 1 ? 's' : ''} had no confident match.`
                                    : 'All unlinked channels were matched.',
                                `Run \`${COMMAND_PREFIX}autolink confirm\` to link all proposals.`,
                            ].join('\n')
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            return;
        }

        // Execute all proposed links
        let successCount = 0;
        const errors: string[] = [];

        for (const proposal of proposals) {
            try {
                const discordWebhook = await this.webhookService.createDiscordWebhook(
                    proposal.discord.id,
                    `Fluxer Bridge Webhook for channel ${proposal.discord.id}`
                );
                const fluxerWebhook = await this.webhookService.createFluxerWebhook(
                    proposal.fluxer.id,
                    `Discord Bridge Webhook for channel ${proposal.fluxer.id}`
                );
                await this.linkService.createChannelLink({
                    guildLinkId: guildLink.id,
                    discordChannelId: proposal.discord.id,
                    fluxerChannelId: proposal.fluxer.id,
                    discordWebhookId: discordWebhook.id,
                    discordWebhookToken: discordWebhook.token,
                    fluxerWebhookId: fluxerWebhook.id,
                    fluxerWebhookToken: fluxerWebhook.token,
                });
                successCount++;
            } catch (err: any) {
                logger.error(
                    `Autolink failed for #${proposal.discord.name} ↔ #${proposal.fluxer.name}:`,
                    err
                );
                errors.push(
                    `\`#${proposal.discord.name}\` ↔ \`#${proposal.fluxer.name}\`: ${err.message}`
                );
            }
        }

        const descriptionLines = [
            `Successfully linked **${successCount}** of **${proposals.length}** proposed channel pair${proposals.length !== 1 ? 's' : ''}.`,
        ];
        if (errors.length > 0) {
            descriptionLines.push('', 'Failures:');
            errors.forEach((e) => descriptionLines.push(`> ${e}`));
        }

        const summaryColor = errors.length > 0 ? EmbedColors.Warning : EmbedColors.Success;

        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(descriptionLines.join('\n'))
                    .setColor(summaryColor)
                    .setFooter(footer).setTimestamp(),
            ],
        });
    }
}

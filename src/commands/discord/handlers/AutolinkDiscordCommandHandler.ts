import { ChannelType, Client, EmbedBuilder } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import { WebhookService } from '../../../services/WebhookService';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import { matchChannels, ChannelInfo } from '../../../utils/channelMatcher';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

export default class AutolinkDiscordCommandHandler extends DiscordCommandHandler {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;
    private readonly fluxerEntityResolver: FluxerEntityResolver;

    constructor(
        client: Client,
        linkService: LinkService,
        webhookService: WebhookService,
        fluxerEntityResolver: FluxerEntityResolver
    ) {
        super(client);
        this.linkService = linkService;
        this.webhookService = webhookService;
        this.fluxerEntityResolver = fluxerEntityResolver;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const isOwner = await this.requireOwner(message);
        if (!isOwner) return;

        const doConfirm = args[0]?.toLowerCase() === 'confirm';

        let guildLink;
        try {
            guildLink = await this.linkService.getGuildLinkForDiscordGuild(message.guildId!);
            if (!guildLink) throw new Error('this guild is not linked to a Fluxer guild');
        } catch (error: any) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Cannot run autolink: ${error.message}. Use \`${COMMAND_PREFIX}linkguild\` first.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message)).setTimestamp()
                ]
            });
            return;
        }

        // Get already-linked channel IDs to skip them
        const existingLinks = await this.linkService.getChannelLinksForDiscordGuild(
            message.guildId!
        );
        const linkedDiscordIds = new Set(existingLinks.map((l) => l.discordChannelId));
        const linkedFluxerIds = new Set(existingLinks.map((l) => l.fluxerChannelId));

        // Fetch all Discord text channels in this guild
        const allDiscordChannels = await message.guild!.channels.fetch();
        const discordTextChannels: ChannelInfo[] = [];
        for (const [, ch] of allDiscordChannels) {
            if (ch && ch.type === ChannelType.GuildText && !linkedDiscordIds.has(ch.id)) {
                discordTextChannels.push({ id: ch.id, name: ch.name });
            }
        }

        // Fetch all Fluxer text channels in the linked Fluxer guild
        const fluxerGuild = await this.fluxerEntityResolver.fetchGuild(guildLink.fluxerGuildId);
        if (!fluxerGuild) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription('Could not fetch the linked Fluxer guild.')
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message)).setTimestamp()
                ]
            });
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allFluxerChannels: any[] = await (fluxerGuild as any).fetchChannels();
        const fluxerTextChannels: ChannelInfo[] = allFluxerChannels
            .filter((ch) => ch.isTextBased() && !linkedFluxerIds.has(ch.id))
            .map((ch) => ({ id: ch.id, name: ch.name as string }));

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
                        .setFooter(this.footer(message)).setTimestamp()
                ]
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
                        .setFooter(this.footer(message)).setTimestamp()
                ]
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

        const isPartial = errors.length > 0;
        const summaryLines = [
            `Successfully linked **${successCount}** of **${proposals.length}** proposed channel pair${proposals.length !== 1 ? 's' : ''}.`,
        ];
        if (isPartial) {
            summaryLines.push('', 'Failures:');
            errors.forEach((e) => summaryLines.push(`> ${e}`));
        }

        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(summaryLines.join('\n'))
                    .setColor(isPartial ? EmbedColors.Warning : EmbedColors.Success)
                    .setFooter(this.footer(message)).setTimestamp()
            ]
        });
    }
}

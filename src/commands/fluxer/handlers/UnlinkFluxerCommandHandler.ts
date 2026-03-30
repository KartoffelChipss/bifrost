import { Client, EmbedBuilder, Message, PermissionsBitField } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import { WebhookService } from '../../../services/WebhookService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

type PendingUnlink =
    | { type: 'guild'; discordGuildId: string }
    | {
          type: 'channel';
          linkId: string;
          discordChannelId: string;
          fluxerChannelId: string;
          discordWebhookId: string;
          discordWebhookToken: string;
          fluxerWebhookId: string;
          fluxerWebhookToken: string;
      };

export default class UnlinkFluxerCommandHandler extends FluxerCommandHandler {
    private pending = new Map<string, { action: PendingUnlink; timer: NodeJS.Timeout }>();

    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly webhookService: WebhookService
    ) {
        super(client);
    }

    private setPending(userId: string, action: PendingUnlink) {
        const existing = this.pending.get(userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(() => this.pending.delete(userId), 5 * 60 * 1000);
        this.pending.set(userId, { action, timer });
    }

    private takePending(userId: string): PendingUnlink | null {
        const entry = this.pending.get(userId);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        return entry.action;
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        // Confirm flow
        if (args[0]?.toLowerCase() === 'confirm') {
            const pending = this.takePending(message.author.id);
            if (!pending) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`No pending unlink action. Run \`${COMMAND_PREFIX}unlink <id>\` first.`)
                            .setColor(EmbedColors.Error)
                            .setFooter(footer).setTimestamp(),
                    ],
                });
                return;
            }

            if (pending.type === 'guild') {
                if (!await this.requireOwner(message)) return;
                try {
                    // Clean up webhooks for all channel links before removing the guild link
                    const channelLinks = await this.linkService
                        .getChannelLinksForFluxerGuild(message.guildId!)
                        .catch(() => []);
                    for (const link of channelLinks) {
                        await this.webhookService
                            .deleteDiscordWebhook(link.discordWebhookId, link.discordWebhookToken)
                            .catch((err) => logger.error('Failed to delete Discord webhook during guild unlink:', err));
                        await this.webhookService
                            .deleteFluxerWebhook(link.fluxerWebhookId, link.fluxerWebhookToken)
                            .catch((err) => logger.error('Failed to delete Fluxer webhook during guild unlink:', err));
                    }
                    await this.linkService.removeGuildLinkFromFluxer(message.guildId!);
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(`Server bridge removed. All channel links have been deleted.`)
                                .setColor(EmbedColors.Success)
                                .setFooter(footer).setTimestamp(),
                        ],
                    });
                } catch (err: any) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(`Failed to unlink guild: ${err.message}`)
                                .setColor(EmbedColors.Error)
                                .setFooter(footer).setTimestamp(),
                        ],
                    });
                    logger.error('Unlink guild failed:', err);
                }
            } else {
                if (!await this.requirePermission(message, PermissionsBitField.Flags.ManageWebhooks, 'Manage Webhooks')) return;
                try {
                    await this.webhookService
                        .deleteDiscordWebhook(pending.discordWebhookId, pending.discordWebhookToken)
                        .catch((err) => logger.error('Failed to delete Discord webhook during channel unlink:', err));
                    await this.webhookService
                        .deleteFluxerWebhook(pending.fluxerWebhookId, pending.fluxerWebhookToken)
                        .catch((err) => logger.error('Failed to delete Fluxer webhook during channel unlink:', err));
                    await this.linkService.removeChannelLinkForFluxer(message.guildId!, pending.linkId);
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(`Channel bridge removed.`)
                                .setColor(EmbedColors.Success)
                                .setFooter(footer).setTimestamp(),
                        ],
                    });
                } catch (err: any) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(`Failed to unlink channel: ${err.message}`)
                                .setColor(EmbedColors.Error)
                                .setFooter(footer).setTimestamp(),
                        ],
                    });
                    logger.error('Unlink channel failed:', err);
                }
            }
            return;
        }

        // Detection phase
        const id = args[0];
        if (!id) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Usage: \`${COMMAND_PREFIX}unlink <id>\`\n` +
                            `> Provide the Discord guild ID to unbridge servers, or a Discord channel ID to remove a channel link.\n` +
                            `> Then run \`${COMMAND_PREFIX}unlink confirm\` to proceed.\n` +
                            `> Use \`${COMMAND_PREFIX}list\` to see active links and their IDs.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            return;
        }

        // 1. Check if ID matches a guild link by Discord guild ID
        const guildLink = await this.linkService.getGuildLinkForDiscordGuild(id).catch(() => null);
        if (guildLink) {
            if (!await this.requireOwner(message)) return;
            this.setPending(message.author.id, { type: 'guild', discordGuildId: id });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This will remove the bridge between this Fluxer server and Discord guild \`${id}\`, ` +
                            `including **all** channel links.\n` +
                            `Run \`${COMMAND_PREFIX}unlink confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            return;
        }

        // 2. Check if ID matches a channel link by Discord channel ID
        const channelLink = await this.linkService.getChannelLinkByDiscordChannelId(id).catch(() => null);
        if (channelLink) {
            if (!await this.requirePermission(message, PermissionsBitField.Flags.ManageWebhooks, 'Manage Webhooks')) return;
            this.setPending(message.author.id, {
                type: 'channel',
                linkId: channelLink.linkId,
                discordChannelId: id,
                fluxerChannelId: channelLink.fluxerChannelId,
                discordWebhookId: channelLink.discordWebhookId,
                discordWebhookToken: channelLink.discordWebhookToken,
                fluxerWebhookId: channelLink.fluxerWebhookId,
                fluxerWebhookToken: channelLink.fluxerWebhookToken,
            });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This will remove the channel bridge for Discord channel \`${id}\` ↔ <#${channelLink.fluxerChannelId}>.\n` +
                            `Run \`${COMMAND_PREFIX}unlink confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer).setTimestamp(),
                ],
            });
            return;
        }

        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        `No active link found for ID \`${id}\`.\n` +
                        `Use \`${COMMAND_PREFIX}list\` to see active links.`
                    )
                    .setColor(EmbedColors.Error)
                    .setFooter(footer).setTimestamp(),
            ],
        });
    }
}

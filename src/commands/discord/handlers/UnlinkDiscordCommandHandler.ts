import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import { WebhookService } from '../../../services/WebhookService';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

type PendingUnlink =
    | { type: 'guild'; fluxerGuildId: string }
    | {
          type: 'channel';
          linkId: string;
          fluxerChannelId: string;
          discordChannelId: string;
          discordWebhookId: string;
          discordWebhookToken: string;
          fluxerWebhookId: string;
          fluxerWebhookToken: string;
      };

export default class UnlinkDiscordCommandHandler extends DiscordCommandHandler {
    private pending = new Map<
        string,
        { action: PendingUnlink; timer: NodeJS.Timeout }
    >();

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
        const timer = setTimeout(
            () => this.pending.delete(userId),
            5 * 60 * 1000
        );
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
        message: DiscordCommandHandlerMessage,
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
                            .setDescription(
                                `No pending unlink action. Run \`${COMMAND_PREFIX}unlink <id>\` first.`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }

            if (pending.type === 'guild') {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionFlagsBits.ManageGuild,
                        'Manage Guild'
                    ))
                )
                    return;
                try {
                    // Clean up webhooks for all channel links before removing the guild link
                    const channelLinks = await this.linkService
                        .getChannelLinksForDiscordGuild(message.guildId!)
                        .catch(() => []);
                    for (const link of channelLinks) {
                        await this.webhookService
                            .deleteDiscordWebhook(
                                link.discordWebhookId,
                                link.discordWebhookToken
                            )
                            .catch((err) =>
                                logger.error(
                                    'Failed to delete Discord webhook during guild unlink:',
                                    err
                                )
                            );
                        await this.webhookService
                            .deleteFluxerWebhook(
                                link.fluxerWebhookId,
                                link.fluxerWebhookToken
                            )
                            .catch((err) =>
                                logger.error(
                                    'Failed to delete Fluxer webhook during guild unlink:',
                                    err
                                )
                            );
                    }
                    await this.linkService.removeGuildLinkFromDiscord(
                        message.guildId!
                    );
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Server bridge removed. All channel links have been deleted.`
                                )
                                .setColor(EmbedColors.Success)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                } catch (err: unknown) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Failed to unlink guild: ${(err as Error).message}`
                                )
                                .setColor(EmbedColors.Error)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                    logger.error('Unlink guild failed:', err);
                }
            } else {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionFlagsBits.ManageWebhooks,
                        'Manage Webhooks'
                    ))
                )
                    return;
                try {
                    await this.webhookService
                        .deleteDiscordWebhook(
                            pending.discordWebhookId,
                            pending.discordWebhookToken
                        )
                        .catch((err) =>
                            logger.error(
                                'Failed to delete Discord webhook during channel unlink:',
                                err
                            )
                        );
                    await this.webhookService
                        .deleteFluxerWebhook(
                            pending.fluxerWebhookId,
                            pending.fluxerWebhookToken
                        )
                        .catch((err) =>
                            logger.error(
                                'Failed to delete Fluxer webhook during channel unlink:',
                                err
                            )
                        );
                    await this.linkService.removeChannelLinkForDiscord(
                        message.guildId!,
                        pending.linkId
                    );
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(`Channel bridge removed.`)
                                .setColor(EmbedColors.Success)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                } catch (err: unknown) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Failed to unlink channel: ${(err as Error).message}`
                                )
                                .setColor(EmbedColors.Error)
                                .setFooter(footer)
                                .setTimestamp(),
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
                                `> Provide the Fluxer guild ID to unbridge servers, or a Fluxer channel ID to remove a channel link.\n` +
                                `> Then run \`${COMMAND_PREFIX}unlink confirm\` to proceed.\n` +
                                `> Use \`${COMMAND_PREFIX}list\` to see active links and their IDs.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // 1. Check if ID matches a guild link by Fluxer guild ID
        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(id)
            .catch(() => null);
        if (guildLink) {
            if (
                !(await this.requirePermission(
                    message,
                    PermissionFlagsBits.ManageGuild,
                    'Manage Guild'
                ))
            )
                return;
            this.setPending(message.author.id, {
                type: 'guild',
                fluxerGuildId: id,
            });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This will remove the bridge between this Discord server and Fluxer guild \`${id}\`, ` +
                                `including **all** channel links.\n` +
                                `Run \`${COMMAND_PREFIX}unlink confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // 2. Check if ID matches a channel link by Fluxer channel ID
        const channelLink = await this.linkService
            .getChannelLinkByFluxerChannelId(id)
            .catch(() => null);
        if (channelLink) {
            if (
                !(await this.requirePermission(
                    message,
                    PermissionFlagsBits.ManageWebhooks,
                    'Manage Webhooks'
                ))
            )
                return;
            this.setPending(message.author.id, {
                type: 'channel',
                linkId: channelLink.linkId,
                fluxerChannelId: id,
                discordChannelId: channelLink.discordChannelId,
                discordWebhookId: channelLink.discordWebhookId,
                discordWebhookToken: channelLink.discordWebhookToken,
                fluxerWebhookId: channelLink.fluxerWebhookId,
                fluxerWebhookToken: channelLink.fluxerWebhookToken,
            });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This will remove the channel bridge for Fluxer channel \`${id}\` ↔ <#${channelLink.discordChannelId}>.\n` +
                                `Run \`${COMMAND_PREFIX}unlink confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer)
                        .setTimestamp(),
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
                    .setFooter(footer)
                    .setTimestamp(),
            ],
        });
    }
}

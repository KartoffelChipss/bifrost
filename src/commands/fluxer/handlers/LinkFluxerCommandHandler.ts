import {
    Client,
    EmbedBuilder,
    Message,
    PermissionsBitField,
} from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import { WebhookService } from '../../../services/WebhookService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

type PendingLink =
    | { type: 'guild'; discordGuildId: string; guildName: string }
    | {
          type: 'channel';
          discordChannelId: string;
          channelName: string;
          guildLinkId: string;
          fluxerChannelId: string;
      };

export default class LinkFluxerCommandHandler extends FluxerCommandHandler {
    private pending = new Map<
        string,
        { action: PendingLink; timer: NodeJS.Timeout }
    >();

    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly webhookService: WebhookService,
        private readonly discordEntityResolver: DiscordEntityResolver
    ) {
        super(client);
    }

    private setPending(userId: string, action: PendingLink) {
        const existing = this.pending.get(userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(
            () => this.pending.delete(userId),
            5 * 60 * 1000
        );
        this.pending.set(userId, { action, timer });
    }

    private takePending(userId: string): PendingLink | null {
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
                            .setDescription(
                                `No pending link action. Run \`${COMMAND_PREFIX}link <id>\` first.`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }

            if (pending.type === 'guild') {
                if (!(await this.requireOwner(message))) return;
                try {
                    await this.linkService.createGuildLink(
                        pending.discordGuildId,
                        message.guildId!
                    );
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `This Fluxer server is now bridged with Discord guild **${pending.guildName}**.\n` +
                                        `Use \`${COMMAND_PREFIX}link <discord-channel-id>\` in any channel to start linking channels.`
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
                                    `Failed to link guild: ${(err as Error).message}`
                                )
                                .setColor(EmbedColors.Error)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                    logger.error('Link guild failed:', err);
                }
            } else {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionsBitField.Flags.ManageWebhooks,
                        'Manage Webhooks'
                    ))
                )
                    return;
                try {
                    const discordWebhook =
                        await this.webhookService.createDiscordWebhook(
                            pending.discordChannelId,
                            `Fluxer Bridge Webhook for channel ${pending.discordChannelId}`
                        );
                    const fluxerWebhook =
                        await this.webhookService.createFluxerWebhook(
                            pending.fluxerChannelId,
                            `Discord Bridge Webhook for channel ${pending.fluxerChannelId}`
                        );
                    await this.linkService.createChannelLink({
                        guildLinkId: pending.guildLinkId,
                        discordChannelId: pending.discordChannelId,
                        fluxerChannelId: pending.fluxerChannelId,
                        discordWebhookId: discordWebhook.id,
                        discordWebhookToken: discordWebhook.token,
                        fluxerWebhookId: fluxerWebhook.id,
                        fluxerWebhookToken: fluxerWebhook.token,
                    });
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Linked this channel ↔ **#${pending.channelName}** on Discord successfully.`
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
                                    `Failed to link channel: ${(err as Error).message}`
                                )
                                .setColor(EmbedColors.Error)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                    logger.error('Link channel failed:', err);
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
                            `Usage: \`${COMMAND_PREFIX}link <id>\`\n` +
                                `> Provide a Discord guild ID to bridge servers, or a Discord channel ID to bridge channels.\n` +
                                `> Then run \`${COMMAND_PREFIX}link confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // 1. Try Discord guild
        const discordGuild = await this.discordEntityResolver
            .fetchGuild(id)
            .catch(() => null);
        if (discordGuild) {
            if (!(await this.requireOwner(message))) return;
            this.setPending(message.author.id, {
                type: 'guild',
                discordGuildId: id,
                guildName: discordGuild.name,
            });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Found Discord guild **${discordGuild.name}**.\n` +
                                `Run \`${COMMAND_PREFIX}link confirm\` to bridge this Fluxer server to it.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // 2. Try Discord channel (requires existing guild link)
        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(message.guildId!)
            .catch(() => null);
        if (guildLink) {
            const discordChannel = await this.discordEntityResolver
                .fetchChannel(guildLink.discordGuildId, id)
                .catch(() => null);
            if (discordChannel) {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionsBitField.Flags.ManageWebhooks,
                        'Manage Webhooks'
                    ))
                )
                    return;
                const channelName =
                    'name' in discordChannel
                        ? ((discordChannel as { name?: string }).name ?? id)
                        : id;
                this.setPending(message.author.id, {
                    type: 'channel',
                    discordChannelId: id,
                    channelName,
                    guildLinkId: guildLink.id,
                    fluxerChannelId: message.channelId,
                });
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Found Discord channel **#${channelName}**.\n` +
                                    `Run \`${COMMAND_PREFIX}link confirm\` to link this channel to it.`
                            )
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }
        }

        // 3. Nothing found
        const hint = guildLink
            ? ''
            : ` (Link a Discord guild first with \`${COMMAND_PREFIX}link <discord-guild-id>\`)`;
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        `Could not find a Discord guild or channel with ID \`${id}\`.${hint}`
                    )
                    .setColor(EmbedColors.Error)
                    .setFooter(footer)
                    .setTimestamp(),
            ],
        });
    }
}

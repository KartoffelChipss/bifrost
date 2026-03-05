import { Client, Message, PermissionFlags } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import { WebhookService } from '../../../services/WebhookService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';

export default class LinkFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly webhookService: WebhookService,
        private readonly discordEntityResolver: DiscordEntityResolver
    ) {
        super(client);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlags.ManageChannels,
            'Manage Channels'
        );
        if (!hasPerms) return;

        const id = args[0];
        const doConfirm = args[1]?.toLowerCase() === 'confirm';

        if (!id) {
            await message.reply(
                `Usage: \`${COMMAND_PREFIX}link <id> [confirm]\`\n` +
                `> Provide a Discord guild ID to bridge servers, or a Discord channel ID to bridge channels.`
            );
            return;
        }

        // --- Detect what the ID refers to ---

        // 1. Try Discord guild
        const discordGuild = await this.discordEntityResolver.fetchGuild(id).catch(() => null);
        if (discordGuild) {
            if (!doConfirm) {
                await message.reply(
                    `Found Discord guild **${discordGuild.name}**.\n` +
                    `Run \`${COMMAND_PREFIX}link ${id} confirm\` to bridge this Fluxer server to it.`
                );
                return;
            }
            try {
                await this.linkService.createGuildLink(id, message.guildId!);
                await message.reply(
                    `This Fluxer server is now bridged with Discord guild **${discordGuild.name}**.\n` +
                    `Use \`${COMMAND_PREFIX}link <discord-channel-id>\` in any channel to start linking channels.`
                );
            } catch (err: any) {
                await message.reply(`Failed to link guild: ${err.message}`);
                logger.error('Link guild failed:', err);
            }
            return;
        }

        // 2. Try Discord channel (requires existing guild link)
        const guildLink = await this.linkService.getGuildLinkForFluxerGuild(message.guildId!).catch(() => null);
        if (guildLink) {
            const discordChannel = await this.discordEntityResolver.fetchChannel(guildLink.discordGuildId, id).catch(() => null);
            if (discordChannel) {
                const channelName = 'name' in discordChannel ? (discordChannel as any).name : id;
                if (!doConfirm) {
                    await message.reply(
                        `Found Discord channel **#${channelName}**.\n` +
                        `Run \`${COMMAND_PREFIX}link ${id} confirm\` to link this channel to it.`
                    );
                    return;
                }
                try {
                    const discordWebhook = await this.webhookService.createDiscordWebhook(
                        id,
                        `Fluxer Bridge Webhook for channel ${id}`
                    );
                    const fluxerWebhook = await this.webhookService.createFluxerWebhook(
                        message.channelId,
                        `Discord Bridge Webhook for channel ${message.channelId}`
                    );
                    await this.linkService.createChannelLink({
                        guildLinkId: guildLink.id,
                        discordChannelId: id,
                        fluxerChannelId: message.channelId,
                        discordWebhookId: discordWebhook.id,
                        discordWebhookToken: discordWebhook.token,
                        fluxerWebhookId: fluxerWebhook.id,
                        fluxerWebhookToken: fluxerWebhook.token,
                    });
                    await message.reply(
                        `Linked this channel ↔ **#${channelName}** on Discord successfully.`
                    );
                } catch (err: any) {
                    await message.reply(`Failed to link channel: ${err.message}`);
                    logger.error('Link channel failed:', err);
                }
                return;
            }
        }

        // 3. Nothing found
        const hint = guildLink
            ? ''
            : ` (Link a Discord guild first with \`${COMMAND_PREFIX}link <discord-guild-id>\`)`;
        await message.reply(`Could not find a Discord guild or channel with ID \`${id}\`.${hint}`);
    }
}

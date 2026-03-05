import { ChannelType, Client, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import { WebhookService } from '../../../services/WebhookService';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';

export default class LinkDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly webhookService: WebhookService,
        private readonly fluxerEntityResolver: FluxerEntityResolver
    ) {
        super(client);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageChannels,
            'Manage Channels'
        );
        if (!hasPerms) return;

        const id = args[0];
        const doConfirm = args[1]?.toLowerCase() === 'confirm';

        if (!id) {
            await message.reply(
                `Usage: \`${COMMAND_PREFIX}link <id> [confirm]\`\n` +
                `> Provide a Fluxer guild ID to bridge servers, or a Fluxer channel ID to bridge channels.`
            );
            return;
        }

        // --- Detect what the ID refers to ---

        // 1. Try Fluxer guild
        const fluxerGuild = await this.fluxerEntityResolver.fetchGuild(id).catch(() => null);
        if (fluxerGuild) {
            if (!doConfirm) {
                await message.reply(
                    `Found Fluxer guild **${(fluxerGuild as any).name ?? id}**.\n` +
                    `Run \`${COMMAND_PREFIX}link ${id} confirm\` to bridge this Discord server to it.`
                );
                return;
            }
            try {
                await this.linkService.createGuildLink(message.guildId!, id);
                await message.reply(
                    `This Discord server is now bridged with Fluxer guild **${(fluxerGuild as any).name ?? id}**.\n` +
                    `Use \`${COMMAND_PREFIX}link <fluxer-channel-id>\` in any channel to start linking channels.`
                );
            } catch (err: any) {
                await message.reply(`Failed to link guild: ${err.message}`);
                logger.error('Link guild failed:', err);
            }
            return;
        }

        // 2. Try Fluxer channel (requires existing guild link)
        const guildLink = await this.linkService.getGuildLinkForDiscordGuild(message.guildId!).catch(() => null);
        if (guildLink) {
            const fluxerChannel = await this.fluxerEntityResolver.fetchChannel(guildLink.fluxerGuildId, id).catch(() => null);
            if (fluxerChannel) {
                if (!doConfirm) {
                    await message.reply(
                        `Found Fluxer channel **#${(fluxerChannel as any).name ?? id}**.\n` +
                        `Run \`${COMMAND_PREFIX}link ${id} confirm\` to link <#${message.channelId}> to it.`
                    );
                    return;
                }
                try {
                    const discordWebhook = await this.webhookService.createDiscordWebhook(
                        message.channelId,
                        `Fluxer Bridge Webhook for channel ${message.channelId}`
                    );
                    const fluxerWebhook = await this.webhookService.createFluxerWebhook(
                        id,
                        `Discord Bridge Webhook for channel ${id}`
                    );
                    await this.linkService.createChannelLink({
                        guildLinkId: guildLink.id,
                        discordChannelId: message.channelId,
                        fluxerChannelId: id,
                        discordWebhookId: discordWebhook.id,
                        discordWebhookToken: discordWebhook.token,
                        fluxerWebhookId: fluxerWebhook.id,
                        fluxerWebhookToken: fluxerWebhook.token,
                    });
                    await message.reply(
                        `Linked <#${message.channelId}> ↔ **#${(fluxerChannel as any).name ?? id}** successfully.`
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
            : ` (Link a Fluxer guild first with \`${COMMAND_PREFIX}link <fluxer-guild-id>\`)`;
        await message.reply(`Could not find a Fluxer guild or channel with ID \`${id}\`.${hint}`);
    }
}

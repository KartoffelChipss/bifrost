import { Client, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';

export default class UnlinkDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService
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
                `Usage: \`${COMMAND_PREFIX}unlink <id> [confirm]\`\n` +
                `> Provide the Fluxer guild ID to unbridge servers, or a Fluxer channel ID to remove a channel link.\n` +
                `> Use \`${COMMAND_PREFIX}list\` to see active links and their IDs.`
            );
            return;
        }

        // 1. Check if ID matches a guild link by Fluxer guild ID
        const guildLink = await this.linkService.getGuildLinkForFluxerGuild(id).catch(() => null);
        if (guildLink) {
            if (!doConfirm) {
                await message.reply(
                    `This will remove the bridge between this Discord server and Fluxer guild \`${id}\`, ` +
                    `including **all** channel links.\n` +
                    `Run \`${COMMAND_PREFIX}unlink ${id} confirm\` to proceed.`
                );
                return;
            }
            try {
                await this.linkService.removeGuildLinkFromDiscord(message.guildId!);
                await message.reply(`Server bridge removed. All channel links have been deleted.`);
            } catch (err: any) {
                await message.reply(`Failed to unlink guild: ${err.message}`);
                logger.error('Unlink guild failed:', err);
            }
            return;
        }

        // 2. Check if ID matches a channel link by Fluxer channel ID
        const channelLink = await this.linkService.getChannelLinkByFluxerChannelId(id).catch(() => null);
        if (channelLink) {
            if (!doConfirm) {
                await message.reply(
                    `This will remove the channel bridge for Fluxer channel \`${id}\` ↔ <#${channelLink.discordChannelId}>.\n` +
                    `Run \`${COMMAND_PREFIX}unlink ${id} confirm\` to proceed.`
                );
                return;
            }
            try {
                await this.linkService.removeChannelLinkForDiscord(message.guildId!, channelLink.linkId);
                await message.reply(`Channel bridge removed.`);
            } catch (err: any) {
                await message.reply(`Failed to unlink channel: ${err.message}`);
                logger.error('Unlink channel failed:', err);
            }
            return;
        }

        await message.reply(
            `No active link found for ID \`${id}\`.\n` +
            `Use \`${COMMAND_PREFIX}list\` to see active links.`
        );
    }
}

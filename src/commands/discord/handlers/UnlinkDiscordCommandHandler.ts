import { Client } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';

type PendingUnlink =
    | { type: 'guild'; fluxerGuildId: string }
    | { type: 'channel'; linkId: string; fluxerChannelId: string; discordChannelId: string };

export default class UnlinkDiscordCommandHandler extends DiscordCommandHandler {
    private pending = new Map<string, { action: PendingUnlink; timer: NodeJS.Timeout }>();

    constructor(
        client: Client,
        private readonly linkService: LinkService
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
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const isOwner = await this.requireOwner(message);
        if (!isOwner) return;

        // Confirm flow
        if (args[0]?.toLowerCase() === 'confirm') {
            const pending = this.takePending(message.author.id);
            if (!pending) {
                await message.reply(
                    `No pending unlink action. Run \`${COMMAND_PREFIX}unlink <id>\` first.`
                );
                return;
            }

            if (pending.type === 'guild') {
                try {
                    await this.linkService.removeGuildLinkFromDiscord(message.guildId!);
                    await message.reply(`Server bridge removed. All channel links have been deleted.`);
                } catch (err: any) {
                    await message.reply(`Failed to unlink guild: ${err.message}`);
                    logger.error('Unlink guild failed:', err);
                }
            } else {
                try {
                    await this.linkService.removeChannelLinkForDiscord(message.guildId!, pending.linkId);
                    await message.reply(`Channel bridge removed.`);
                } catch (err: any) {
                    await message.reply(`Failed to unlink channel: ${err.message}`);
                    logger.error('Unlink channel failed:', err);
                }
            }
            return;
        }

        // Detection phase
        const id = args[0];
        if (!id) {
            await message.reply(
                `Usage: \`${COMMAND_PREFIX}unlink <id>\`\n` +
                `> Provide the Fluxer guild ID to unbridge servers, or a Fluxer channel ID to remove a channel link.\n` +
                `> Then run \`${COMMAND_PREFIX}unlink confirm\` to proceed.\n` +
                `> Use \`${COMMAND_PREFIX}list\` to see active links and their IDs.`
            );
            return;
        }

        // 1. Check if ID matches a guild link by Fluxer guild ID
        const guildLink = await this.linkService.getGuildLinkForFluxerGuild(id).catch(() => null);
        if (guildLink) {
            this.setPending(message.author.id, { type: 'guild', fluxerGuildId: id });
            await message.reply(
                `This will remove the bridge between this Discord server and Fluxer guild \`${id}\`, ` +
                `including **all** channel links.\n` +
                `Run \`${COMMAND_PREFIX}unlink confirm\` to proceed.`
            );
            return;
        }

        // 2. Check if ID matches a channel link by Fluxer channel ID
        const channelLink = await this.linkService.getChannelLinkByFluxerChannelId(id).catch(() => null);
        if (channelLink) {
            this.setPending(message.author.id, {
                type: 'channel',
                linkId: channelLink.linkId,
                fluxerChannelId: id,
                discordChannelId: channelLink.discordChannelId,
            });
            await message.reply(
                `This will remove the channel bridge for Fluxer channel \`${id}\` ↔ <#${channelLink.discordChannelId}>.\n` +
                `Run \`${COMMAND_PREFIX}unlink confirm\` to proceed.`
            );
            return;
        }

        await message.reply(
            `No active link found for ID \`${id}\`.\n` +
            `Use \`${COMMAND_PREFIX}list\` to see active links.`
        );
    }
}

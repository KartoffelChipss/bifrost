import { Client, EmbedBuilder, GuildMember, Message, PermissionResolvable } from '@fluxerjs/core';
import CommandHandler from '../CommandHandler';
import logger from '../../utils/logging/logger';
import { EmbedColors } from '../../utils/embeds';
import { DELETE_INVOCATION } from '../../utils/env';

export default abstract class FluxerCommandHandler extends CommandHandler<Client, Message> {
    protected footer(message: Message) {
        if (!DELETE_INVOCATION) return null;
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        return {
            text: `${message.author.username} used ${message.content} • ${time}`,
            iconURL: (message.author as any).avatarURL?.() ?? undefined,
        };
    }

    protected async requirePermission(
        message: Message,
        permission: PermissionResolvable,
        permissionDisplayName?: string
    ): Promise<boolean> {
        let authorMember: GuildMember | null = null;
        try {
            authorMember = (await message.guild?.fetchMember(message.author.id)) || null;
        } catch (error) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription('Could not fetch your member information.')
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message)).setTimestamp(),
                ],
            });
            logger.error(
                'Failed fetching member for Fluxer permission check',
                {
                    fluxerGuildId: message.guildId,
                    fluxerChannelId: message.channelId,
                    authorId: message.author.id,
                },
                error
            );
            return false;
        }
        if (!authorMember) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription('Could not fetch your member information.')
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message)).setTimestamp(),
                ],
            });
            return false;
        }

        if (!authorMember.permissions.has(permission)) {
            const displayName = permissionDisplayName || permission;
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`You need the \`${displayName}\` permission to use this command.`)
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message)).setTimestamp(),
                ],
            });
            return false;
        }
        return true;
    }

    protected async requireOwner(message: Message): Promise<boolean> {
        if ((message.guild as any)?.ownerId !== message.author.id) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription('Only the server owner can use this command.')
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message)).setTimestamp(),
                ],
            });
            return false;
        }
        return true;
    }
}

import { Client, EmbedBuilder, Message, OmitPartialGroupDMChannel, PermissionResolvable } from 'discord.js';
import CommandHandler from '../CommandHandler';
import { EmbedColors } from '../../utils/embeds';
import { DELETE_INVOCATION } from '../../utils/env';

export type DiscordCommandHandlerMessage = OmitPartialGroupDMChannel<Message<boolean>>;

export default abstract class DiscordCommandHandler extends CommandHandler<
    Client,
    DiscordCommandHandlerMessage
> {
    protected footer(message: DiscordCommandHandlerMessage) {
        if (!DELETE_INVOCATION) return null;
        return {
            text: `${message.author.username} used ${message.content}`,
            iconURL: message.author.displayAvatarURL(),
        };
    }

    protected async requirePermission(
        message: DiscordCommandHandlerMessage,
        permission: PermissionResolvable,
        permissionDisplayName?: string
    ): Promise<boolean> {
        let member = null;
        try {
            member = await message.guild?.members.fetch(message.author.id);
            if (!member) {
                throw new Error('Member not found');
            }
        } catch (error) {
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

        if (!member.permissions.has(permission)) {
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

    protected async requireOwner(message: DiscordCommandHandlerMessage): Promise<boolean> {
        if (message.guild?.ownerId !== message.author.id) {
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

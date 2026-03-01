import { Client, Message, OmitPartialGroupDMChannel, PermissionResolvable } from 'discord.js';
import CommandHandler from '../CommandHandler';

export type DiscordCommandHandlerMessage = OmitPartialGroupDMChannel<Message<boolean>>;

export default abstract class DiscordCommandHandler extends CommandHandler<
    Client,
    DiscordCommandHandlerMessage
> {
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
            await message.reply('Could not fetch your member information.');
            return false;
        }

        if (!member.permissions.has(permission)) {
            const displayName = permissionDisplayName || permission;
            await message.reply(`You need the \`${displayName}\` permission to use this command.`);
            return false;
        }

        return true;
    }
}

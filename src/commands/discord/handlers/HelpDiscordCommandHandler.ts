import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getHelpMessage } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

export default class HelpDiscordCommandHandler extends DiscordCommandHandler {
    constructor(client: Client) {
        super(client);
    }

    async handleCommand(message: DiscordCommandHandlerMessage): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageWebhooks,
            'Manage Webhooks'
        );
        if (!hasPerms) return;
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Bifrost Help')
                    .setDescription(getHelpMessage('discord'))
                    .setColor(EmbedColors.Info)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }
}

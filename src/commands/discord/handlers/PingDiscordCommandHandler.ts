import { EmbedBuilder } from 'discord.js';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { EmbedColors } from '../../../utils/embeds';

export default class PingDiscordCommandHandler extends DiscordCommandHandler {
    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ..._args: string[]
    ): Promise<void> {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription('Pong!')
                    .setColor(EmbedColors.Success)
                    .setFooter(this.footer(message)).setTimestamp(),
            ],
        });
    }
}

import { EmbedBuilder, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { EmbedColors } from '../../../utils/embeds';

export default class PingFluxerCommandHandler extends FluxerCommandHandler {
    public async handleCommand(
        message: Message,
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

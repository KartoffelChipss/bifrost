import { Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';

export default class PingFluxerCommandHandler extends FluxerCommandHandler {
    public async handleCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void> {
        await message.reply('Pong!');
    }
}

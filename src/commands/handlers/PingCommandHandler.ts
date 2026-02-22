import { Message } from '@fluxerjs/core';
import CommandHandler from '../CommandHandler';

export default class PingCommandHandler extends CommandHandler {
    public async handleCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void> {
        await message.reply('Pong!');
    }
}

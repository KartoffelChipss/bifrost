import { Client, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getHelpMessage } from '../../../commands/commandList';

export default class HelpFluxerCommandHandler extends FluxerCommandHandler {
    constructor(client: Client) {
        super(client);
    }

    async handleCommand(message: Message, command: string, ...args: string[]): Promise<void> {
        await message.reply(getHelpMessage('fluxer'));
    }
}

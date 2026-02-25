import { Client } from 'discord.js';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { getHelpMessage } from '../../../commands/commandList';

export default class HelpDiscordCommandHandler extends DiscordCommandHandler {
    constructor(client: Client) {
        super(client);
    }

    async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        await message.reply(getHelpMessage('discord'));
    }
}

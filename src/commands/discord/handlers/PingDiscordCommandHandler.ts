import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';

export default class PingDiscordCommandHandler extends DiscordCommandHandler {
    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        await message.reply('Pong!');
    }
}

import { randomName } from '../../../utils/randomName';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { ChannelType } from 'discord.js';

export default class WebhooktestDiscordCommandHandler extends DiscordCommandHandler {
    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        if (message.channel.type !== ChannelType.GuildText) {
            await message.reply('This command can only be used in a guild text channel.');
            return;
        }

        const webhook = await message.channel.createWebhook({
            name: `Test Webhook ${randomName()}`,
        });

        await webhook.send({
            content: `Hello, ${args[0] || 'World'}! This is a message sent via webhook.`,
            username: randomName(),
        });
        await webhook.delete();
    }
}

import { Message, TextChannel } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { randomName } from '../../../utils/randomName';

export default class WebhooktestFluxerCommandHandler extends FluxerCommandHandler {
    public async handleCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const client = this.getClient();
        const channel = (await client.channels.fetch(message.channelId)) as TextChannel;
        if (!channel) return;

        const webhook = await channel.createWebhook({ name: 'My Webhook' });
        const helloName = args[0] || 'World';
        await webhook.send({
            content: `Hello, ${helloName}! This is a message sent via webhook.`,
            username: randomName(),
        });
        await webhook.delete();
    }
}

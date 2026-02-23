import { Client, Message, OmitPartialGroupDMChannel } from 'discord.js';

export type DiscordCommandHandlerMessage = OmitPartialGroupDMChannel<Message<boolean>>;

export default abstract class DiscordCommandHandler {
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    public abstract handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void>;

    public getClient(): Client {
        return this.client;
    }
}

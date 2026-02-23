import { Client, Message } from '@fluxerjs/core';

export default abstract class FluxerCommandHandler {
    private readonly client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    public abstract handleCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void>;

    protected getClient(): Client {
        return this.client;
    }
}

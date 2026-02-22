import { Message } from '@fluxerjs/core';
import CommandHandler from './CommandHandler';

export default class CommandRegistry {
    private readonly commandHandlers: Map<string, CommandHandler>;

    constructor() {
        this.commandHandlers = new Map();
    }

    public registerCommand(command: string, handler: CommandHandler): void {
        this.commandHandlers.set(command, handler);
    }

    public getCommandHandler(command: string): CommandHandler | undefined {
        return this.commandHandlers.get(command);
    }

    public async executeCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const handler = this.getCommandHandler(command);
        if (!handler) {
            console.warn(`No handler found for command: ${command}`);
            return;
        }

        try {
            await handler.handleCommand(message, command, ...args);
        } catch (error) {
            console.error(`Error executing command "${command}":`, error);
        }
    }
}

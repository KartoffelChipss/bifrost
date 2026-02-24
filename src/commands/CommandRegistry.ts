import CommandHandler from './CommandHandler';

export default class CommandRegistry<T extends CommandHandler<any, any>> {
    private readonly commandHandlers: Map<string, T>;

    constructor() {
        this.commandHandlers = new Map();
    }

    public registerCommand(command: string, handler: T): void {
        this.commandHandlers.set(command, handler);
    }

    public getCommandHandler(command: string): T | undefined {
        return this.commandHandlers.get(command);
    }
}

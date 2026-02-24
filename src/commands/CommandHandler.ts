export default abstract class CommandHandler<T, U> {
    private readonly client: T;

    constructor(client: T) {
        this.client = client;
    }

    public abstract handleCommand(message: U, command: string, ...args: string[]): Promise<void>;

    protected getClient(): T {
        return this.client;
    }
}

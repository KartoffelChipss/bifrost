export default abstract class StatsService<Client> {
    private client: Client | null = null;

    public setClient(client: Client) {
        this.client = client;
    }

    protected getClient(): Client | null {
        return this.client;
    }

    abstract getGuildCount(): number;
    abstract getUserCount(): number;
    abstract getPing(): number;
}

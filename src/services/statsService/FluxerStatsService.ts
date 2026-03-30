import { Client } from '@fluxerjs/core';
import StatsService from './StatsService';

export default class FluxerStatsService extends StatsService<Client> {
    private static readonly PING_CACHE_DURATION = 60_000; // 60 seconds

    private lastPing: number | null = null;
    private lastPingTime: number | null = null;

    getGuildCount(): number {
        return this.getClient()?.guilds.size || NaN;
    }
    getUserCount(): number {
        return this.getClient()?.users.size || NaN;
    }
    async getPing(): Promise<number> {
        const client = this.getClient();
        if (!client) return NaN;

        if (
            this.lastPing &&
            this.lastPingTime &&
            Date.now() - this.lastPingTime <
                FluxerStatsService.PING_CACHE_DURATION
        ) {
            return this.lastPing;
        }

        const start = Date.now();
        await client.rest.get('/gateway/bot');
        const end = Date.now();

        this.lastPing = end - start;
        this.lastPingTime = Date.now();
        return this.lastPing;
    }
}

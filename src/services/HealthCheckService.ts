import { Client as FluxerClient } from '@fluxerjs/core';
import { Client as DiscordClient } from 'discord.js';
import logger from '../utils/logging/logger';

interface HealthStatus {
    healthy: boolean;
    message?: string;
}

export default class HealthCheckService {
    private readonly discordPushUrl: string | null;
    private readonly fluxerPushUrl: string | null;
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

    constructor(discordPushUrl: string | null, fluxerPushUrl: string | null) {
        this.discordPushUrl = discordPushUrl;
        this.fluxerPushUrl = fluxerPushUrl;
    }

    public setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    public setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    private async checkDiscordHealth(): Promise<HealthStatus> {
        if (!this.discordClient)
            return { healthy: false, message: 'Discord client not initialized' };
        try {
            if (this.discordClient.ws.status !== 0)
                return { healthy: false, message: 'Discord client is not connected' };
            await this.discordClient.application?.fetch();
            return { healthy: true };
        } catch (err) {
            return { healthy: false, message: `Error checking Discord health: ${err}` };
        }
    }

    private async checkFluxerHealth(): Promise<HealthStatus> {
        if (!this.fluxerClient) return { healthy: false, message: 'Fluxer client not initialized' };
        try {
            await this.fluxerClient.rest.get('/gateway/bot');
            return { healthy: true };
        } catch (err) {
            return { healthy: false, message: `Error checking Fluxer health: ${err}` };
        }
    }

    private async pushHealthStatus(pushUrl: string, status: HealthStatus): Promise<void> {
        const url = new URL(pushUrl);
        url.searchParams.append('status', status.healthy ? 'up' : 'down');
        if (status.message) url.searchParams.append('msg', status.message);
        await fetch(url, { method: 'GET' });
    }

    public async pushDiscordHealthStatus(): Promise<void> {
        if (!this.discordPushUrl) return;

        const healthStatus = await this.checkDiscordHealth();
        if (healthStatus.healthy) {
            logger.info(`Discord health status: UP`);
        } else {
            logger.warn(
                `Discord health status: DOWN${healthStatus.message ? ` - ${healthStatus.message}` : ''}`
            );
        }
        await this.pushHealthStatus(this.discordPushUrl, healthStatus);
    }

    public async pushFluxerHealthStatus(): Promise<void> {
        if (!this.fluxerPushUrl) return;

        const healthStatus = await this.checkFluxerHealth();
        if (healthStatus.healthy) {
            logger.info(`Fluxer health status: UP`);
        } else {
            logger.warn(
                `Fluxer health status: DOWN${healthStatus.message ? ` - ${healthStatus.message}` : ''}`
            );
        }
        await this.pushHealthStatus(this.fluxerPushUrl, healthStatus);
    }
}

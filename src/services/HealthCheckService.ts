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
    private lastFluxerHealthy: boolean | null = null;
    private onFluxerRecovered: (() => void) | null = null;
    private fluxerConsecutiveDowns = 0;
    private onFluxerDown: ((count: number) => void) | null = null;

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

    public setOnFluxerRecovered(cb: () => void) {
        this.onFluxerRecovered = cb;
    }

    public setOnFluxerDown(cb: (count: number) => void) {
        this.onFluxerDown = cb;
    }

    public resetFluxerDownCount() {
        this.fluxerConsecutiveDowns = 0;
    }

    private async checkDiscordHealth(): Promise<HealthStatus> {
        if (!this.discordClient)
            return {
                healthy: false,
                message: 'Discord client not initialized',
            };
        try {
            if (this.discordClient.ws.status !== 0)
                return {
                    healthy: false,
                    message: 'Discord client is not connected',
                };
            await this.discordClient.application?.fetch();
            return { healthy: true };
        } catch (err) {
            return {
                healthy: false,
                message: `Error checking Discord health: ${err}`,
            };
        }
    }

    private async checkFluxerHealth(): Promise<HealthStatus> {
        if (!this.fluxerClient)
            return { healthy: false, message: 'Fluxer client not initialized' };
        try {
            await this.fluxerClient.rest.get('/gateway/bot');
            const isReady = this.fluxerClient.isReady();
            if (!isReady) {
                return {
                    healthy: false,
                    message: 'Fluxer client is not ready',
                };
            }
            return { healthy: true };
        } catch (err) {
            return {
                healthy: false,
                message: `Error checking Fluxer health: ${err}`,
            };
        }
    }

    private async pushHealthStatus(
        pushUrl: string,
        status: HealthStatus
    ): Promise<void> {
        const url = new URL(pushUrl);
        url.searchParams.append('status', status.healthy ? 'up' : 'down');
        if (status.message) url.searchParams.append('msg', status.message);
        if (ping !== undefined) url.searchParams.append('ping', String(ping));
        try {
            await fetch(url, { method: 'GET' });
        } catch (err) {
            logger.error(`Failed to push health status to ${pushUrl}: ${err}`);
        }
    }

    public async pushDiscordHealthStatus(): Promise<void> {
        if (!this.discordPushUrl) return;

        const start = Date.now();
        const healthStatus = await this.checkDiscordHealth();
        const ping = Date.now() - start;

        if (healthStatus.healthy) {
            logger.info(`Discord health status: UP`);
        } else {
            logger.warn(
                `Discord health status: DOWN${healthStatus.message ? ` - ${healthStatus.message}` : ''}`
            );
        }
        await this.pushHealthStatus(this.discordPushUrl, healthStatus, ping);
    }

    public async pushFluxerHealthStatus(): Promise<void> {
        if (!this.fluxerPushUrl) return;

        const start = Date.now();
        const healthStatus = await this.checkFluxerHealth();
        const ping = Date.now() - start;

        if (healthStatus.healthy) {
            this.fluxerConsecutiveDowns = 0;
            logger.info(`Fluxer health status: UP`);
            if (this.lastFluxerHealthy === false) {
                logger.info('Fluxer recovered');
                this.onFluxerRecovered?.();
            }
        } else {
            this.fluxerConsecutiveDowns++;
            logger.warn(
                `Fluxer health status: DOWN${healthStatus.message ? ` - ${healthStatus.message}` : ''} (consecutive: ${this.fluxerConsecutiveDowns})`
            );
            this.onFluxerDown?.(this.fluxerConsecutiveDowns);
        }
        this.lastFluxerHealthy = healthStatus.healthy;
        await this.pushHealthStatus(this.fluxerPushUrl, healthStatus);
    }
}

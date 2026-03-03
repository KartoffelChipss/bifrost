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

        const redacted = new URL(url.toString());
        const parts = redacted.pathname.split('/');
        parts[parts.length - 1] = '[REDACTED]';
        redacted.pathname = parts.join('/');
        logger.debug(`Health push → ${redacted.toString()}`);

        try {
            const res = await fetch(url, { method: 'GET' });
            const body = await res.text();
            logger.debug(`Health push response: HTTP ${res.status} — ${body}`);

            if (!res.ok) {
                logger.error(`Health push failed: HTTP ${res.status} from ${redacted}`);
                return;
            }

            try {
                const json = JSON.parse(body) as { ok: boolean; msg?: string };
                if (!json.ok) {
                    const msg = json.msg ?? 'unknown error';
                    if (msg.toLowerCase().includes('not found')) {
                        logger.warn(`Health push rejected — monitor not found at ${redacted}`);
                    } else {
                        logger.error(`Health push rejected — ${msg}`);
                    }
                }
            } catch {
                logger.warn(`Health push: unexpected non-JSON response from ${redacted}`);
            }
        } catch (err) {
            logger.error(`Failed to push health status to ${redacted}: ${err}`);
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

    private async getFluxerPlatformStatus(): Promise<string | null> {
        try {
            const res = await fetch('https://fluxerstatus.com/summary.json');
            if (!res.ok) return null;
            const json = await res.json() as {
                page: { status: string };
                activeIncidents: { name: string; impact: string }[];
                activeMaintenances: { name: string }[];
            };
            if (json.page.status === 'UP') return null;
            const incidents = json.activeIncidents.map((i) => `${i.name} (${i.impact})`).join(', ');
            const maintenances = json.activeMaintenances.map((m) => m.name).join(', ');
            const details = [incidents, maintenances].filter(Boolean).join('; ');
            return details ? `${json.page.status} — ${details}` : json.page.status;
        } catch {
            return null;
        }
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

import { Client as FluxerClient } from '@fluxerjs/core';
import { ActivityType, Client as DiscordClient } from 'discord.js';
import logger from '../utils/logging/logger';
import MetricsService from './MetricsService';

interface HealthStatus {
    healthy: boolean;
    message?: string;
}

export default class HealthCheckService {
    private readonly discordPushUrl: string | null;
    private readonly fluxerPushUrl: string | null;
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;
    private metricsService: MetricsService | null = null;
    private lastDiscordHealthy: boolean | null = null;
    private lastFluxerHealthy: boolean | null = null;
    private onDiscordRecovered: (() => void) | null = null;
    private onFluxerRecovered: (() => void) | null = null;
    private fluxerConsecutiveDowns = 0;
    private onFluxerDown: ((count: number) => void) | null = null;

    constructor(discordPushUrl: string | null, fluxerPushUrl: string | null) {
        this.discordPushUrl = discordPushUrl;
        this.fluxerPushUrl = fluxerPushUrl;
    }

    public setMetricsService(metricsService: MetricsService) {
        this.metricsService = metricsService;
    }

    public setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    public setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    public setOnDiscordRecovered(cb: () => void) {
        this.onDiscordRecovered = cb;
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
            const gatewayBot = await this.fluxerClient.rest.get('/gateway/bot');
            logger.debug(
                `Fluxer /gateway/bot response: ${JSON.stringify(gatewayBot)}`
            );
            const isReady = this.fluxerClient.isReady();
            if (!isReady) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const ws = (this.fluxerClient as any).ws;
                const guilds = this.fluxerClient.guilds.size;
                const userId = this.fluxerClient.user?.id ?? 'none';
                const aborted = ws?._aborted ?? 'unknown';
                const gatewayUrl = ws?.gatewayUrl ?? 'unknown';
                const shardCount = ws?.shardCount ?? 'unknown';
                // shards is a Map<number, Shard> — log each shard's status
                const shardStatuses: string[] = [];
                if (ws?.shards instanceof Map) {
                    for (const [id, shard] of ws.shards) {
                        const shardKeys = Object.keys(shard as object).join(
                            ', '
                        );
                        shardStatuses.push(
                            `shard ${id}: status=${(shard as { status?: string }).status ?? '?'}, keys=[${shardKeys}]`
                        );
                    }
                } else {
                    shardStatuses.push(`shards type: ${typeof ws?.shards}`);
                }
                logger.debug(
                    `Fluxer client not yet ready — guilds cached: ${guilds}, user: ${userId}, ` +
                        `aborted: ${aborted}, gateway: ${gatewayUrl}, shardCount: ${shardCount}, ` +
                        `shards: [${shardStatuses.join(' | ')}]`
                );
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
        status: HealthStatus,
        ping?: number
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
                let errDetail = '';
                try {
                    const json = JSON.parse(body) as {
                        ok?: boolean;
                        msg?: string;
                    };
                    if (json.msg) errDetail = ` — ${json.msg}`;
                } catch {
                    /* body wasn't JSON */
                }
                logger.error(
                    `Health push failed: HTTP ${res.status} from ${redacted}${errDetail}`
                );
                return;
            }

            try {
                const json = JSON.parse(body) as { ok: boolean; msg?: string };
                if (!json.ok) {
                    const msg = json.msg ?? 'unknown error';
                    if (msg.toLowerCase().includes('not found')) {
                        logger.warn(
                            `Health push rejected — monitor not found at ${redacted}`
                        );
                    } else {
                        logger.error(`Health push rejected — ${msg}`);
                    }
                }
            } catch {
                logger.warn(
                    `Health push: unexpected non-JSON response from ${redacted}`
                );
            }
        } catch (err) {
            logger.error(`Failed to push health status to ${redacted}: ${err}`);
        }
    }

    private updateFluxerPresence(healthy: boolean): void {
        if (!this.fluxerClient?.user) return;
        // @fluxerjs/core types don't expose setPresence — cast to access the runtime method
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const user = this.fluxerClient.user as any;
        if (healthy) {
            user.setPresence?.({
                status: 'online',
                custom_status: { text: 'Bridging to Discord' },
            });
        } else {
            user.setPresence?.({
                status: 'dnd',
                custom_status: {
                    text: 'Discord unreachable — messages queued',
                },
            });
        }
    }

    private updateDiscordPresence(healthy: boolean): void {
        if (!this.discordClient?.user) return;
        if (healthy) {
            this.discordClient.user.setStatus('online');
            this.discordClient.user.setActivity('Bridging to Fluxer', {
                type: ActivityType.Watching,
            });
        } else {
            this.discordClient.user.setStatus('dnd');
            this.discordClient.user.setActivity(
                'Fluxer unreachable — messages queued',
                { type: ActivityType.Watching }
            );
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
        this.metricsService?.discordUp.set(healthStatus.healthy ? 1 : 0);
        this.metricsService?.healthPingMs.set({ bot: 'discord' }, ping);
        await this.pushHealthStatus(this.discordPushUrl, healthStatus, ping);

        // Update Fluxer bot presence to reflect Discord state
        this.updateFluxerPresence(healthStatus.healthy);

        // Trigger queue drain on recovery
        if (healthStatus.healthy && this.lastDiscordHealthy === false) {
            logger.info('Discord recovered — triggering queue drain');
            this.onDiscordRecovered?.();
        }
        this.lastDiscordHealthy = healthStatus.healthy;
    }

    private async getFluxerPlatformStatus(): Promise<string | null> {
        try {
            const res = await fetch('https://fluxerstatus.com/summary.json');
            if (!res.ok) return null;
            const json = (await res.json()) as {
                page: { status: string };
                activeIncidents: { name: string; impact: string }[];
                activeMaintenances: { name: string }[];
            };
            if (json.page.status === 'UP') return null;
            const incidents = json.activeIncidents
                .map((i) => `${i.name} (${i.impact})`)
                .join(', ');
            const maintenances = json.activeMaintenances
                .map((m) => m.name)
                .join(', ');
            const details = [incidents, maintenances]
                .filter(Boolean)
                .join('; ');
            return details
                ? `${json.page.status} — ${details}`
                : json.page.status;
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
        } else {
            this.fluxerConsecutiveDowns++;
            logger.warn(
                `Fluxer health status: DOWN${healthStatus.message ? ` - ${healthStatus.message}` : ''} (consecutive: ${this.fluxerConsecutiveDowns})`
            );
            const platformStatus = await this.getFluxerPlatformStatus();
            if (platformStatus) {
                logger.warn(`Fluxer platform status: ${platformStatus}`);
            }
            this.onFluxerDown?.(this.fluxerConsecutiveDowns);
        }
        this.metricsService?.fluxerUp.set(healthStatus.healthy ? 1 : 0);
        this.metricsService?.healthPingMs.set({ bot: 'fluxer' }, ping);
        await this.pushHealthStatus(this.fluxerPushUrl, healthStatus, ping);

        // Update Discord bot presence to reflect Fluxer state
        this.updateDiscordPresence(healthStatus.healthy);

        // Trigger queue drain on recovery
        if (healthStatus.healthy && this.lastFluxerHealthy === false) {
            logger.info('Fluxer recovered — triggering queue drain');
            this.onFluxerRecovered?.();
        }
        this.lastFluxerHealthy = healthStatus.healthy;
    }
}

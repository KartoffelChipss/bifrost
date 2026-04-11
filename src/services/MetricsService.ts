import http from 'http';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import logger from '../utils/logging/logger';

export default class MetricsService {
    private readonly registry: Registry;

    public readonly discordUp: Gauge;
    public readonly fluxerUp: Gauge;
    public readonly healthPingMs: Gauge<'bot'>;
    public readonly messagesRelayed: Counter<'direction'>;
    public readonly messageRelayErrors: Counter<'direction'>;

    constructor(port: number) {
        this.registry = new Registry();
        collectDefaultMetrics({ register: this.registry });

        this.discordUp = new Gauge({
            name: 'bifrost_discord_up',
            help: '1 if Discord bot is healthy, 0 otherwise',
            registers: [this.registry],
        });

        this.fluxerUp = new Gauge({
            name: 'bifrost_fluxer_up',
            help: '1 if Fluxer bot is healthy, 0 otherwise',
            registers: [this.registry],
        });

        this.healthPingMs = new Gauge({
            name: 'bifrost_health_ping_ms',
            help: 'Health check round-trip ping in milliseconds',
            labelNames: ['bot'],
            registers: [this.registry],
        });

        this.messagesRelayed = new Counter({
            name: 'bifrost_messages_relayed_total',
            help: 'Total number of messages successfully relayed',
            labelNames: ['direction'],
            registers: [this.registry],
        });

        this.messageRelayErrors = new Counter({
            name: 'bifrost_message_relay_errors_total',
            help: 'Total number of message relay errors',
            labelNames: ['direction'],
            registers: [this.registry],
        });

        const server = http.createServer(async (req, res) => {
            if (req.url === '/metrics') {
                res.setHeader('Content-Type', this.registry.contentType);
                res.end(await this.registry.metrics());
            } else {
                res.statusCode = 404;
                res.end();
            }
        });

        server.listen(port, () => {
            logger.info(`Metrics server listening on port ${port}`);
        });
    }
}

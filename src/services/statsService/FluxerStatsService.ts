import { Client } from '@fluxerjs/core';
import StatsService from './StatsService';

export default class FluxerStatsService extends StatsService<Client> {
    getGuildCount(): number {
        return this.getClient()?.guilds.size || NaN;
    }
    getUserCount(): number {
        return this.getClient()?.users.size || NaN;
    }
    getPing(): number {
        // FluxerJS does not track heartbeat round-trip time — lastHeartbeatAck is a boolean
        // flag and heartbeatAt is the next scheduled send time, not timestamps suitable for delta.
        return NaN;
    }
}

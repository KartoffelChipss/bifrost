import { Client } from '@fluxerjs/core';
import StatsService from './StatsService';

export default class FluxerStatsService extends StatsService<Client> {
    getGuildCount(): number {
        return this.getClient()?.guilds.size || NaN;
    }
    getUserCount(): number {
        return this.getClient()?.users.size || NaN;
    }
}

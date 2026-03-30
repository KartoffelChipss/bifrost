import { Client } from 'discord.js';
import StatsService from './StatsService';

export default class DiscordStatsService extends StatsService<Client> {
    getGuildCount(): number {
        return this.getClient()?.guilds.cache.size || NaN;
    }
    getUserCount(): number {
        return this.getClient()?.users.cache.size || NaN;
    }
    getPing(): number {
        return this.getClient()?.ws.ping ?? NaN;
    }
}

import { Client, EmbedBuilder } from 'discord.js';
import DiscordCommandHandler, { DiscordCommandHandlerMessage } from '../DiscordCommandHandler';
import { formatDuration } from '../../../utils/duration';
import { getHeapUsageMB } from '../../../utils/memory';
import StatsService from '../../../services/statsService/StatsService';

export default class StatsDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private discordStatsService: StatsService<any>,
        private fluxerStatsService: StatsService<any>
    ) {
        super(client);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const fluxerGuildCount = this.fluxerStatsService.getGuildCount();
        const discordGuildCount = this.discordStatsService.getGuildCount();
        const fluxerUserCount = this.fluxerStatsService.getUserCount();
        const discordUserCount = this.discordStatsService.getUserCount();
        const readableUptime = formatDuration(process.uptime());
        const usedHeap = getHeapUsageMB();

        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Fluxer Bot Stats')
                    .addFields(
                        {
                            name: 'Fluxer Guilds',
                            value: `${isNaN(fluxerGuildCount) ? 'N/A' : fluxerGuildCount}`,
                            inline: true,
                        },
                        {
                            name: 'Discord Guilds',
                            value: `${isNaN(discordGuildCount) ? 'N/A' : discordGuildCount}`,
                            inline: true,
                        },
                        {
                            name: 'Fluxer Users',
                            value: `${isNaN(fluxerUserCount) ? 'N/A' : fluxerUserCount}`,
                            inline: true,
                        },
                        {
                            name: 'Discord Users',
                            value: `${isNaN(discordUserCount) ? 'N/A' : discordUserCount}`,
                            inline: true,
                        },
                        { name: 'Uptime', value: readableUptime, inline: true },
                        { name: 'Memory Usage', value: `${usedHeap} MB`, inline: true }
                    )
                    .setColor(0x252529),
            ],
        });
    }
}

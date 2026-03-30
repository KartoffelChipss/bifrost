import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { formatDuration } from '../../../utils/duration';
import { getHeapUsageMB } from '../../../utils/memory';
import StatsService from '../../../services/statsService/StatsService';
import { EmbedColors } from '../../../utils/embeds';
import {
    DISCORD_APP_ID,
    FLUXER_APP_ID,
    GIT_COMMIT,
    REPO_URL,
} from '../../../utils/env';
import {
    generateDiscordBotInviteLink,
    generateFluxerBotInviteLink,
} from '../../../utils/generateBotInvite';
import { DbStatsService } from '../../../services/DbStatsService';

export default class StatsDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private discordStatsService: StatsService<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private fluxerStatsService: StatsService<any>,
        private dbStatsService: DbStatsService
    ) {
        super(client);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage
    ): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageWebhooks,
            'Manage Webhooks'
        );
        if (!hasPerms) return;
        const fluxerGuildCount = this.fluxerStatsService.getGuildCount();
        const discordGuildCount = this.discordStatsService.getGuildCount();
        const fluxerUserCount = this.fluxerStatsService.getUserCount();
        const discordUserCount = this.discordStatsService.getUserCount();
        const discordPing = await this.discordStatsService.getPing();
        const fluxerPing = await this.fluxerStatsService.getPing();
        const readableUptime = formatDuration(process.uptime());
        const usedHeap = getHeapUsageMB();
        const dbStats = await this.dbStatsService.getStats();

        const perms = '536947712';
        const inviteValue = `[Fluxer](${generateFluxerBotInviteLink(FLUXER_APP_ID, perms)}) | [Discord](${generateDiscordBotInviteLink(DISCORD_APP_ID, perms)})`;

        const buildValue = GIT_COMMIT
            ? REPO_URL
                ? `[\`${GIT_COMMIT.slice(0, 7)}\`](${REPO_URL}/commit/${GIT_COMMIT})`
                : `\`${GIT_COMMIT.slice(0, 7)}\``
            : 'N/A';

        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Bifröst Stats')
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
                        {
                            name: 'Channel Links',
                            value: `${dbStats.channelLinksCount}`,
                            inline: true,
                        },
                        {
                            name: 'Message Links',
                            value: `${dbStats.messageLinksCount}`,
                            inline: true,
                        },
                        {
                            name: 'Latency',
                            value: `Discord: ${isNaN(discordPing) ? 'N/A' : `${discordPing}ms`} | Fluxer: ${isNaN(fluxerPing) ? 'Not Yet Supported' : `${fluxerPing}ms`}`,
                            inline: false,
                        },
                        { name: 'Uptime', value: readableUptime, inline: true },
                        {
                            name: 'Memory Usage',
                            value: `${usedHeap} MB`,
                            inline: true,
                        },
                        { name: 'Build', value: buildValue, inline: true },
                        { name: 'Invite', value: inviteValue, inline: false }
                    )
                    .setColor(EmbedColors.Info)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }
}

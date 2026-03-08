import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { formatDuration } from '../../../utils/duration';
import StatsService from '../../../services/statsService/StatsService';
import { getHeapUsageMB } from '../../../utils/memory';
import { EmbedColors } from '../../../utils/embeds';
import { DISCORD_APP_ID, FLUXER_APP_ID, GIT_COMMIT, REPO_URL } from '../../../utils/env';
import { generateDiscordBotInviteLink, generateFluxerBotInviteLink } from '../../../utils/generateBotInvite';

export default class StatsFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private discordStatsService: StatsService<any>,
        private fluxerStatsService: StatsService<any>
    ) {
        super(client);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ..._args: string[]
    ): Promise<void> {
        const hasPerms = await this.requirePermission(message, PermissionFlags.ManageWebhooks, 'Manage Webhooks');
        if (!hasPerms) return;
        const fluxerGuildCount = this.fluxerStatsService.getGuildCount();
        const discordGuildCount = this.discordStatsService.getGuildCount();
        const fluxerUserCount = this.fluxerStatsService.getUserCount();
        const discordUserCount = this.discordStatsService.getUserCount();
        const discordPing = this.discordStatsService.getPing();
        const fluxerPing = this.fluxerStatsService.getPing();
        const readableUptime = formatDuration(process.uptime());
        const usedHeap = getHeapUsageMB();

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
                    .setTitle('Bifrost Stats')
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
                            name: 'Latency',
                            value: `Discord: ${isNaN(discordPing) ? 'N/A' : `${discordPing}ms`} | Fluxer: ${isNaN(fluxerPing) ? 'Not Yet Supported' : `${fluxerPing}ms`}`,
                            inline: false,
                        },
                        { name: 'Uptime', value: readableUptime, inline: true },
                        { name: 'Memory Usage', value: `${usedHeap} MB`, inline: true },
                        { name: 'Build', value: buildValue, inline: true },
                        { name: 'Invite', value: inviteValue, inline: false }
                    )
                    .setColor(EmbedColors.Info)
                    .setFooter(this.footer(message)).setTimestamp(),
            ],
        });
    }
}

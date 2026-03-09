import { LinkService } from '../../../services/LinkService';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../../../utils/logging/logger';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import { EmbedColors } from '../../../utils/embeds';

export default class GuildLinkDiscordCommandHandler extends DiscordCommandHandler {
    private readonly linkService: LinkService;
    private readonly fluxerEntityResolver: FluxerEntityResolver;

    constructor(
        client: Client,
        linkService: LinkService,
        fluxerEntityResolver: FluxerEntityResolver
    ) {
        super(client);
        this.linkService = linkService;
        this.fluxerEntityResolver = fluxerEntityResolver;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);
        const discordGuildId = message.guildId!;

        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageGuild,
            'Manage Guild'
        );
        if (!hasPerms) return;

        if (args.length < 1 || args[0].toLowerCase() === 'help') {
            const usage = getDiscordCommandUsage(command);
            await message.reply(usage);
            return;
        }

        const [rawGuildId] = args;
        const fluxerGuildId = rawGuildId.replace(/^<|>$/g, '');

        try {
            const fluxerGuild =
                await this.fluxerEntityResolver.fetchGuild(fluxerGuildId);
            if (!fluxerGuild) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Fluxer Guild Not Found')
                            .setDescription(
                                `Could not find Fluxer guild with ID \`${fluxerGuildId}\`.`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Verifying Fluxer Guild')
                        .setDescription(
                            `Failed to verify Fluxer guild: ${errorMessage}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error(
                'Failed verifying Fluxer guild for Discord guild link command',
                {
                    command,
                    discordGuildId,
                    fluxerGuildId,
                },
                error
            );
            return;
        }

        try {
            await this.linkService.createGuildLink(
                discordGuildId,
                fluxerGuildId
            );
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Guild Linked')
                        .setDescription(
                            `Successfully linked Discord guild \`${discordGuildId}\` with Fluxer guild \`${fluxerGuildId}\`.`
                        )
                        .setColor(EmbedColors.Success)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Error Creating Guild Link')
                        .setDescription(
                            `Failed to create guild link: ${errorMessage}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error('Error creating guild link:', error);
        }
    }
}

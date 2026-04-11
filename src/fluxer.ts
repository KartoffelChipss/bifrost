import {
    Client,
    EmbedBuilder,
    Events,
    PartialMessage,
    TextChannel,
} from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import {
    isCommandString,
    parseCommandString,
} from './commands/parseCommandString';
import { EmbedColors } from './utils/embeds';
import logger from './utils/logging/logger';
import FluxerCommandHandler from './commands/fluxer/FluxerCommandHandler';
import { COMMAND_PREFIX, DELETE_INVOCATION, FLUXER_TOKEN } from './utils/env';
import { LinkService } from './services/LinkService';
import LinkFluxerCommandHandler from './commands/fluxer/handlers/LinkFluxerCommandHandler';
import UnlinkFluxerCommandHandler from './commands/fluxer/handlers/UnlinkFluxerCommandHandler';
import ListFluxerCommandHandler from './commands/fluxer/handlers/ListFluxerCommandHandler';
import { WebhookService } from './services/WebhookService';
import FluxerToDiscordMessageRelay from './services/messageRelay/FluxerToDiscordMessageRelay';
import HelpFluxerCommandHandler from './commands/fluxer/handlers/HelpFluxerCommandHandler';
import AutolinkFluxerCommandHandler from './commands/fluxer/handlers/AutolinkFluxerCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import FluxerMessageTransformer from './services/messageTransformer/FluxerMessageTransformer';
import MetricsService from './services/MetricsService';
import MessageQueueService from './services/MessageQueueService';
import StatsFluxerCommandHandler from './commands/fluxer/handlers/StatsFluxerCommandHandler';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import { DbStatsService } from './services/DbStatsService';

const startFluxerClient = async ({
    linkService,
    webhookService,
    healthCheckService,
    discordEntityResolver,
    fluxerEntityResolver,
    metricsService,
    queueService,
    discordStatsService,
    fluxerStatsService,
    dbStatsService,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    healthCheckService: HealthCheckService;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
    metricsService?: MetricsService;
    queueService?: MessageQueueService;
    discordStatsService: DiscordStatsService;
    fluxerStatsService: FluxerStatsService;
    dbStatsService: DbStatsService;
}): Promise<Client> => {
    const client = new Client({
        intents: 0,
        waitForGuilds: true,
        presence: {
            status: 'online',
            custom_status: {
                text: 'Bridging to Discord',
            },
        },
    });

    webhookService.setFluxerClient(client);
    healthCheckService.setFluxerClient(client);
    fluxerEntityResolver.setFluxerClient(client);
    fluxerStatsService.setClient(client);

    const messageTransformer = new FluxerMessageTransformer();
    const messageRelay = new FluxerToDiscordMessageRelay({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        discordEntityResolver,
    });

    const commandRegistry = new CommandRegistry<FluxerCommandHandler>();
    commandRegistry.registerCommand(
        'help',
        new HelpFluxerCommandHandler(client)
    );
    commandRegistry.registerCommand(
        'stats',
        new StatsFluxerCommandHandler(
            client,
            discordStatsService,
            fluxerStatsService,
            dbStatsService
        )
    );
    commandRegistry.registerCommand(
        'link',
        new LinkFluxerCommandHandler(
            client,
            linkService,
            webhookService,
            discordEntityResolver
        )
    );
    commandRegistry.registerCommand(
        'unlink',
        new UnlinkFluxerCommandHandler(client, linkService, webhookService)
    );
    commandRegistry.registerCommand(
        'list',
        new ListFluxerCommandHandler(client, linkService, discordEntityResolver)
    );
    commandRegistry.registerCommand(
        'autolink',
        new AutolinkFluxerCommandHandler(
            client,
            linkService,
            webhookService,
            discordEntityResolver
        )
    );

    client.once(Events.Ready, () => {
        logger.info('Fluxer bot is ready!');
        healthCheckService.pushFluxerHealthStatus();
    });

    client.on(Events.Error, (error) => {
        logger.error('Fluxer client error:', error);
    });

    client.on(Events.MessageDelete, async (message: PartialMessage) => {
        const messageLink = await linkService.getMessageLinkByFluxerMessageId(
            message.id
        );
        if (!messageLink) return;

        try {
            linkService.deleteMessageLink(messageLink.id);
        } catch (error) {
            logger.error('Error deleting message link from database:', error);
        }

        const channelLink = await linkService.getChannelLinkById(
            messageLink.channelLinkId
        );
        if (!channelLink) return;

        const guildLink = await linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) return;

        const msg = await discordEntityResolver.fetchMessage(
            guildLink.discordGuildId,
            channelLink.discordChannelId,
            messageLink.discordMessageId
        );
        if (!msg) {
            logger.error(
                'Could not find linked Discord message to delete for Fluxer message ID:',
                message.id
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error('Error deleting message from Discord:', error);
        }
    });

    client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
        const linkedMessage = await linkService.getMessageLinkByFluxerMessageId(
            newMessage.id
        );
        if (!linkedMessage) return;

        const linkedChannel = await linkService.getChannelLinkById(
            linkedMessage.channelLinkId
        );
        if (!linkedChannel) return;

        const webhook = await webhookService.getDiscordWebhook(
            linkedChannel.discordWebhookId,
            linkedChannel.discordWebhookToken
        );
        if (!webhook) {
            logger.warn(
                `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message update`
            );
            return;
        }

        const newMsg = await messageTransformer.transformMessage(newMessage);
        try {
            await webhookService.editMessageViaDiscordWebhook(
                webhook,
                linkedMessage.discordMessageId,
                newMsg
            );
        } catch (error) {
            logger.error('Error relaying message update to Discord:', error);
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.id === client.user?.id) return;

        if (message.guildId && message.webhookId) {
            const webhookLink =
                await linkService.getChannelLinkByFluxerChannelId(
                    message.channelId
                );
            if (
                webhookLink &&
                webhookLink.fluxerWebhookId === message.webhookId
            )
                return;
        }

        if (isCommandString(message.content, COMMAND_PREFIX)) {
            const { command, args } = parseCommandString(
                message.content,
                COMMAND_PREFIX
            );
            const handler = commandRegistry.getCommandHandler(command);
            if (!handler) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Unknown command: \`${command}\`\nUse \`${COMMAND_PREFIX}help\` to see available commands.`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter({
                                text: `${message.author.username} used ${message.content} • ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`,
                                iconURL:
                                    (
                                        message.author as {
                                            avatarURL?: () =>
                                                | string
                                                | undefined;
                                        }
                                    ).avatarURL?.() ?? undefined,
                            })
                            .setTimestamp(),
                    ],
                });
                return;
            }

            try {
                await handler.handleCommand(message, command, ...args);
            } catch (error) {
                logger.error(
                    `Error executing fluxer command "${command}":`,
                    error
                );
            }

            if (DELETE_INVOCATION && message.guildId) {
                message
                    .delete()
                    .catch((err: unknown) =>
                        logger.error(
                            'Failed to delete invocation message:',
                            err
                        )
                    );
            }
        }

        if (
            message.guildId &&
            message.channel instanceof TextChannel &&
            !isCommandString(message.content, COMMAND_PREFIX)
        ) {
            await messageRelay.relayMessage(message);
        }
    });

    await client.login(FLUXER_TOKEN);

    return client;
};

export default startFluxerClient;

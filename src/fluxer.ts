import {
    Client,
    EmbedBuilder,
    Events,
    PartialMessage,
    TextChannel,
} from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import PingFluxerCommandHandler from './commands/fluxer/handlers/PingFluxerCommandHandler';
import {
    isCommandString,
    parseCommandString,
} from './commands/parseCommandString';
import './utils/env';
import logger from './utils/logging/logger';
import FluxerCommandHandler from './commands/fluxer/FluxerCommandHandler';
import { COMMAND_PREFIX, FLUXER_TOKEN } from './utils/env';
import GuildLinkFluxerCommandHandler from './commands/fluxer/handlers/GuildLinkFluxerCommandHandler';
import GuildUnlinkFluxerCommandHandler from './commands/fluxer/handlers/GuildUnlinkFluxerCommandHandler';
import { LinkService } from './services/LinkService';
import ChannelLinkFluxerCommandHandler from './commands/fluxer/handlers/ChannelLinkFluxerCommandHandler';
import ListChannelsFluxerCommandHandler from './commands/fluxer/handlers/ListChannelsFluxerCommandHandler';
import ChannelUnlinkFluxerCommandHandler from './commands/fluxer/handlers/ChannelUnlinkFluxerCommandHandler';
import { WebhookService } from './services/WebhookService';
import FluxerToDiscordMessageRelay from './services/messageRelay/FluxerToDiscordMessageRelay';
import HelpFluxerCommandHandler from './commands/fluxer/handlers/HelpFluxerCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import FluxerMessageTransformer from './services/messageTransformer/FluxerMessageTransformer';
import StatsFluxerCommandHandler from './commands/fluxer/handlers/StatsFluxerCommandHandler';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import { EmbedColors } from './utils/embeds';
import { DbStatsService } from './services/DbStatsService';

const startFluxerClient = async ({
    linkService,
    webhookService,
    healthCheckService,
    discordEntityResolver,
    fluxerEntityResolver,
    discordStatsService,
    fluxerStatsService,
    dbStatsService,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    healthCheckService: HealthCheckService;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
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
        discordEntityResolver,
    });

    const commandRegistry = new CommandRegistry<FluxerCommandHandler>();
    commandRegistry.registerCommand(
        'ping',
        new PingFluxerCommandHandler(client)
    );
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
        'linkguild',
        new GuildLinkFluxerCommandHandler(
            client,
            linkService,
            discordEntityResolver
        )
    );
    commandRegistry.registerCommand(
        'unlinkguild',
        new GuildUnlinkFluxerCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'linkchannel',
        new ChannelLinkFluxerCommandHandler(
            client,
            linkService,
            webhookService,
            discordEntityResolver
        )
    );
    commandRegistry.registerCommand(
        'listchannels',
        new ListChannelsFluxerCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'unlinkchannel',
        new ChannelUnlinkFluxerCommandHandler(client, linkService)
    );

    setInterval(async () => {
        await healthCheckService.pushFluxerHealthStatus();
    }, 30_000);

    client.once(Events.Ready, () => {
        logger.info('Fluxer bot is ready!');
        logger.info(`Fluxer bot is in ${client.guilds.size} guilds`);
    });

    client.on(Events.Error, (error) => {
        logger.error('Fluxer client error', { client: 'fluxer' }, error);
    });

    client.on(Events.MessageDelete, async (message: PartialMessage) => {
        const messageLink = await linkService.getMessageLinkByFluxerMessageId(
            message.id
        );
        if (!messageLink) return;

        try {
            linkService.deleteMessageLink(messageLink.id);
        } catch (error) {
            logger.error(
                'Failed to delete message link from database',
                {
                    source: 'fluxer.messageDelete',
                    fluxerMessageId: message.id,
                    messageLinkId: messageLink.id,
                    channelLinkId: messageLink.channelLinkId,
                    guildLinkId: messageLink.guildLinkId,
                },
                error
            );
        }

        const channelLink = await linkService.getChannelLinkById(
            messageLink.channelLinkId
        );
        if (!channelLink) return;

        const guildLink = await linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) return;

        //console.log('Deleting Discord message with ID:', messageLink.discordMessageId);
        const msg = await discordEntityResolver.fetchMessage(
            guildLink.discordGuildId,
            channelLink.discordChannelId,
            messageLink.discordMessageId
        );
        if (!msg) {
            logger.error(
                'Could not find linked Discord message for delete propagation',
                {
                    source: 'fluxer.messageDelete',
                    fluxerMessageId: message.id,
                    channelLinkId: channelLink.id,
                    guildLinkId: guildLink.id,
                    discordMessageId: messageLink.discordMessageId,
                }
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error(
                'Failed to delete linked Discord message',
                {
                    source: 'fluxer.messageDelete',
                    fluxerMessageId: message.id,
                    discordMessageId: messageLink.discordMessageId,
                    discordGuildId: guildLink.discordGuildId,
                    discordChannelId: channelLink.discordChannelId,
                },
                error
            );
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

        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

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

        const discordEmojis = await discordEntityResolver.fetchEmojis(
            guildLink.discordGuildId
        );

        const newMsg = await messageTransformer.transformMessage(
            newMessage,
            discordEmojis
        );
        try {
            await webhookService.editMessageViaDiscordWebhook(
                webhook,
                linkedMessage.discordMessageId,
                newMsg
            );
        } catch (error) {
            logger.error(
                'Failed relaying Fluxer message update to Discord',
                {
                    source: 'fluxer.messageUpdate',
                    fluxerMessageId: newMessage.id,
                    discordMessageId: linkedMessage.discordMessageId,
                    channelLinkId: linkedChannel.id,
                    guildLinkId: linkedChannel.guildLinkId,
                },
                error
            );
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.id === client.user?.id) return;
        if (!message.guildId) return;

        if (message.webhookId) {
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
                            .setTitle('Unknown Command')
                            .setDescription(
                                `Unknown command: \`${command}\`\nUse \`${COMMAND_PREFIX}help\` to see available commands.`
                            )
                            .setColor(EmbedColors.Error),
                    ],
                });
                return;
            }

            try {
                await handler.handleCommand(message, command, ...args);
            } catch (error) {
                logger.error(
                    'Fluxer command execution failed',
                    {
                        source: 'fluxer.messageCreate.command',
                        command,
                        args,
                        guildId: message.guildId,
                        channelId: message.channelId,
                        authorId: message.author.id,
                    },
                    error
                );
            }
        }

        if (
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

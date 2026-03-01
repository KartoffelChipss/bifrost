import { Client, Events, PartialMessage, TextChannel } from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import PingFluxerCommandHandler from './commands/fluxer/handlers/PingFluxerCommandHandler';
import { isCommandString, parseCommandString } from './commands/parseCommandString';
import './utils/env';
import logger from './utils/logging/logger';
import FluxerCommandHandler from './commands/fluxer/FluxerCommandHandler';
import { COMMAND_PREFIX } from './utils/env';
import GuildLinkFluxerCommandHandler from './commands/fluxer/handlers/GuildLinkFluxerCommandHandler';
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

const startFluxerClient = async ({
    linkService,
    webhookService,
    healthCheckService,
    discordEntityResolver,
    fluxerEntityResolver,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    healthCheckService: HealthCheckService;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
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

    const messageTransformer = new FluxerMessageTransformer();
    const messageRelay = new FluxerToDiscordMessageRelay({
        linkService,
        webhookService,
        messageTransformer,
    });

    const commandRegistry = new CommandRegistry<FluxerCommandHandler>();
    commandRegistry.registerCommand('ping', new PingFluxerCommandHandler(client));
    commandRegistry.registerCommand('help', new HelpFluxerCommandHandler(client));
    commandRegistry.registerCommand(
        'linkguild',
        new GuildLinkFluxerCommandHandler(client, linkService)
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

    client.once(Events.Ready, () => {
        logger.info('Fluxer bot is ready!');
        logger.info(`Fluxer bot is in ${client.guilds.size} guilds`);

        setInterval(async () => {
            await healthCheckService.pushFluxerHealthStatus();
        }, 30_000);
    });

    client.on(Events.Error, (error) => {
        logger.error('Fluxer client error:', error);
    });

    client.on(Events.MessageDelete, async (message: PartialMessage) => {
        const messageLink = await linkService.getMessageLinkByFluxerMessageId(message.id);
        if (!messageLink) return;

        try {
            linkService.deleteMessageLink(messageLink.id);
        } catch (error) {
            logger.error('Error deleting message link from database:', error);
        }

        const channelLink = await linkService.getChannelLinkById(messageLink.channelLinkId);
        if (!channelLink) return;

        const guildLink = await linkService.getGuildLinkById(channelLink.guildLinkId);
        if (!guildLink) return;

        //console.log('Deleting Discord message with ID:', messageLink.discordMessageId);
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

    client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
        const linkedMessage = await linkService.getMessageLinkByFluxerMessageId(newMessage.id);
        if (!linkedMessage) return;

        const linkedChannel = await linkService.getChannelLinkById(linkedMessage.channelLinkId);
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
        if (message.author.bot) return;

        if (!message.guildId) return;

        if (isCommandString(message.content, COMMAND_PREFIX)) {
            const { command, args } = parseCommandString(message.content, COMMAND_PREFIX);
            const handler = commandRegistry.getCommandHandler(command);
            if (!handler) {
                await message.reply(
                    `Unknown command: \`${command}\`\nUse \`${COMMAND_PREFIX}help\` to see available commands.`
                );
                return;
            }

            try {
                await handler.handleCommand(message, command, ...args);
            } catch (error) {
                logger.error(`Error executing fluxer command "${command}":`, error);
            }
        }

        if (
            message.channel instanceof TextChannel &&
            !isCommandString(message.content, COMMAND_PREFIX)
        ) {
            await messageRelay.relayMessage(message);
        }
    });

    await client.login(process.env.FLUXER_BOT_TOKEN!);

    return client;
};

export default startFluxerClient;

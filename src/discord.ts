import { Client, GatewayIntentBits, Partials, TextChannel } from 'discord.js';
import { COMMAND_PREFIX, DISCORD_BOT_TOKEN } from './utils/env';
import logger from './utils/logging/logger';
import CommandRegistry from './commands/CommandRegistry';
import DiscordCommandHandler from './commands/discord/DiscordCommandHandler';
import { isCommandString, parseCommandString } from './commands/parseCommandString';
import PingDiscordCommandHandler from './commands/discord/handlers/PingDiscordCommandHandler';
import { LinkService } from './services/LinkService';
import GuildLinkDiscordCommandHandler from './commands/discord/handlers/GuildLinkDiscordCommandHandler';
import ChannelLinkDiscordCommandHandler from './commands/discord/handlers/ChannelLinkDiscordCommandHandler';
import ListChannelsDiscordCommandHandler from './commands/discord/handlers/ListChannelsDiscordCommandHandler';
import ChannelUnlinkDiscordCommandHandler from './commands/discord/handlers/ChannelUnlinkDiscordCommandHandler';
import { WebhookService } from './services/WebhookService';
import DiscordToFluxerMessageRelay from './services/DiscordToFluxerMessageRelay';
import HelpDiscordCommandHandler from './commands/discord/handlers/HelpDiscordCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import BridgeEntityResolver from './services/BridgeEntityResolver';

const startDiscordClient = async ({
    linkService,
    webhookService,
    healthCheckService,
    channelMessageFetcher,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    healthCheckService: HealthCheckService;
    channelMessageFetcher: BridgeEntityResolver;
}): Promise<Client> => {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Message, Partials.Channel],
    });

    webhookService.setDiscordClient(client);
    healthCheckService.setDiscordClient(client);
    channelMessageFetcher.setDiscordClient(client);

    const messageRelay = new DiscordToFluxerMessageRelay({
        linkService,
        webhookService,
    });

    const commandRegistry = new CommandRegistry<DiscordCommandHandler>();
    commandRegistry.registerCommand('ping', new PingDiscordCommandHandler(client));
    commandRegistry.registerCommand('help', new HelpDiscordCommandHandler(client));
    commandRegistry.registerCommand(
        'linkguild',
        new GuildLinkDiscordCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'linkchannel',
        new ChannelLinkDiscordCommandHandler(
            client,
            linkService,
            webhookService,
            channelMessageFetcher
        )
    );
    commandRegistry.registerCommand(
        'listchannels',
        new ListChannelsDiscordCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'unlinkchannel',
        new ChannelUnlinkDiscordCommandHandler(client, linkService)
    );

    client.once('clientReady', () => {
        logger.info(`Discord bot logged in as ${client.user?.tag}`);

        setInterval(async () => {
            await healthCheckService.pushDiscordHealthStatus();
        }, 30_000);
    });

    client.on('error', (error) => {
        logger.error('Discord client error:', error);
    });

    client.on('messageDelete', async (message) => {
        if (message.webhookId) return;

        const messageLink = await linkService.getMessageLinkByDiscordMessageId(message.id);
        if (!messageLink) return;

        try {
            linkService.deleteMessageLink(messageLink.id);
        } catch (error) {
            logger.error('Error deleting message link from database:', error);
        }

        const channelLink = await linkService.getChannelLinkById(messageLink.channelLinkId);
        if (!channelLink) return;

        const webhook = await webhookService.getFluxerWebhook(
            channelLink.fluxerWebhookId,
            channelLink.fluxerWebhookToken
        );
        if (!webhook) return;

        console.log('Deleting Fluxer message with ID:', messageLink.fluxerMessageId);
        const msg = await channelMessageFetcher.fetchFluxerMessage(
            channelLink.fluxerChannelId,
            messageLink.fluxerMessageId
        );
        console.log('Fetched Fluxer message:', msg);
    });

    client.on('messageCreate', async (message) => {
        if (message.author.id === client.user?.id) return;
        if (message.author.bot) return;

        if (!message.inGuild()) return;

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
                logger.error(`Error executing discord command "${command}":`, error);
            }
        }

        if (
            message.channel instanceof TextChannel &&
            !isCommandString(message.content, COMMAND_PREFIX)
        ) {
            await messageRelay.relayMessage(message);
        }
    });

    await client.login(DISCORD_BOT_TOKEN);

    return client;
};

export default startDiscordClient;

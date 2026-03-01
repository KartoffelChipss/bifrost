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
import FluxerEntityResolver from './services/FluxerEntityResolver';
import DiscordEntityResolver from './services/DiscordEntityResolver';

const startDiscordClient = async ({
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
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Message, Partials.Channel],
    });

    webhookService.setDiscordClient(client);
    healthCheckService.setDiscordClient(client);
    discordEntityResolver.setDiscordClient(client);

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
            fluxerEntityResolver
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
        if (!message.inGuild()) return;

        console.log('Discord message deleted with ID:', message.id);

        const messageLink = await linkService.getMessageLinkByDiscordMessageId(message.id);
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

        //console.log('Deleting Fluxer message with ID:', messageLink.fluxerMessageId);
        const msg = await fluxerEntityResolver.fetchMessage(
            guildLink.fluxerGuildId,
            channelLink.fluxerChannelId,
            messageLink.fluxerMessageId
        );
        if (!msg) {
            logger.error(
                'Could not find linked Fluxer message to delete for Discord message ID:',
                message.id
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error('Error deleting message from Fluxer:', error);
        }
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

import { Client, GatewayIntentBits } from 'discord.js';
import { COMMAND_PREFIX, DISCORD_BOT_TOKEN } from './utils/env';
import logger from './utils/logging/logger';
import CommandRegistry from './commands/CommandRegistry';
import DiscordCommandHandler from './commands/discord/DiscordCommandHandler';
import { isCommandString, parseCommandString } from './commands/parseCommandString';
import PingDiscordCommandHandler from './commands/discord/handlers/PingDiscordCommandHandler';
import WebhooktestDiscordCommandHandler from './commands/discord/handlers/WebhooktestDiscordCommandHandler';
import { LinkService } from './services/LinkService';
import GuildLinkDiscordCommandHandler from './commands/discord/handlers/GuildLinkDiscordCommandHandler';
import ChannelLinkDiscordCommandHandler from './commands/discord/handlers/ChannelLinkDiscordCommandHandler';

const startDiscordClient = async ({
    linkService,
}: {
    linkService: LinkService;
}): Promise<Client> => {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    const commandRegistry = new CommandRegistry<DiscordCommandHandler>();
    commandRegistry.registerCommand('ping', new PingDiscordCommandHandler(client));
    commandRegistry.registerCommand('webhooktest', new WebhooktestDiscordCommandHandler(client));
    commandRegistry.registerCommand(
        'guildlink',
        new GuildLinkDiscordCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'channellink',
        new ChannelLinkDiscordCommandHandler(client, linkService)
    );

    client.once('clientReady', () => {
        logger.info(`Discord bot logged in as ${client.user?.tag}`);
    });

    client.on('messageCreate', async (message) => {
        if (message.author.id === client.user?.id) return;
        if (message.author.bot) return;

        if (!message.inGuild()) return;

        if (isCommandString(message.content, COMMAND_PREFIX)) {
            const { command, args } = parseCommandString(message.content, COMMAND_PREFIX);
            const handler = commandRegistry.getCommandHandler(command);
            if (!handler) {
                logger.warn(`No handler found for command: ${command}`);
                return;
            }

            try {
                await handler.handleCommand(message, command, ...args);
            } catch (error) {
                logger.error(`Error executing discord command "${command}":`, error);
            }
        }
    });

    await client.login(DISCORD_BOT_TOKEN);

    return client;
};

export default startDiscordClient;

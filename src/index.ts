import { Client } from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import PingCommandHandler from './commands/handlers/PingCommandHandler';
import { isCommandString, parseCommandString } from './commands/parseCommandString';
import WebhooktestCommandHandler from './commands/handlers/WebhooktestCommandHandler';
import './utils/env';
import logger from './utils/logging/logger';

const commandPrefix = process.env.COMMAND_PREFIX || '!';

const commandRegistry = new CommandRegistry();

const main = async () => {
    const client = new Client({ intents: 0, waitForGuilds: true });

    commandRegistry.registerCommand('ping', new PingCommandHandler(client));
    commandRegistry.registerCommand('webhooktest', new WebhooktestCommandHandler(client));

    client.events
        .Ready(() => {
            logger.info('Fluxer bot is ready!');
            logger.info(`Fluxer bot is in ${client.guilds.size} guilds`);
        })
        .events.MessageCreate(async (message) => {
            if (isCommandString(message.content, commandPrefix)) {
                const { command, args } = parseCommandString(message.content, commandPrefix);
                await commandRegistry.executeCommand(message, command, ...args);
                return;
            }
        });

    await client.login(process.env.FLUXER_BOT_TOKEN!);
};

main().catch((error) => logger.error(error));

import { Client } from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import PingCommandHandler from './commands/fluxer/handlers/PingCommandHandler';
import { isCommandString, parseCommandString } from './commands/parseCommandString';
import WebhooktestCommandHandler from './commands/fluxer/handlers/WebhooktestCommandHandler';
import './utils/env';
import logger from './utils/logging/logger';
import FluxerCommandHandler from './commands/fluxer/FluxerCommandHandler';

const commandPrefix = process.env.COMMAND_PREFIX || '!';

const commandRegistry = new CommandRegistry<FluxerCommandHandler>();

const startFluxerClient = async (): Promise<Client> => {
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
                const handler = commandRegistry.getCommandHandler(command);
                if (!handler) {
                    logger.warn(`No handler found for command: ${command}`);
                    return;
                }

                try {
                    await handler.handleCommand(message, command, ...args);
                } catch (error) {
                    logger.error(`Error executing command "${command}":`, error);
                }
                return;
            }
        });

    await client.login(process.env.FLUXER_BOT_TOKEN!);

    return client;
};

export default startFluxerClient;

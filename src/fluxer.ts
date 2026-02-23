import { Client } from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import PingFluxerCommandHandler from './commands/fluxer/handlers/PingFluxerCommandHandler';
import { isCommandString, parseCommandString } from './commands/parseCommandString';
import WebhooktestFluxerCommandHandler from './commands/fluxer/handlers/WebhooktestFluxerCommandHandler';
import './utils/env';
import logger from './utils/logging/logger';
import FluxerCommandHandler from './commands/fluxer/FluxerCommandHandler';
import { COMMAND_PREFIX } from './utils/env';

const commandRegistry = new CommandRegistry<FluxerCommandHandler>();

const startFluxerClient = async (): Promise<Client> => {
    const client = new Client({ intents: 0, waitForGuilds: true });

    commandRegistry.registerCommand('ping', new PingFluxerCommandHandler(client));
    commandRegistry.registerCommand('webhooktest', new WebhooktestFluxerCommandHandler(client));

    client.events
        .Ready(() => {
            logger.info('Fluxer bot is ready!');
            logger.info(`Fluxer bot is in ${client.guilds.size} guilds`);
        })
        .events.MessageCreate(async (message) => {
            if (message.author.id === client.user?.id) return;
            if (message.author.bot) return;

            if (!message.guildId) return;

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
                    logger.error(`Error executing fluxer command "${command}":`, error);
                }
            }
        });

    await client.login(process.env.FLUXER_BOT_TOKEN!);

    return client;
};

export default startFluxerClient;

import { Client, TextChannel } from '@fluxerjs/core';
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
import FluxerToDiscordMessageRelay from './services/FluxerToDiscordMessageRelay';
import HelpFluxerCommandHandler from './commands/fluxer/handlers/HelpFluxerCommandHandler';

const startFluxerClient = async ({
    linkService,
    webhookService,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
}): Promise<Client> => {
    const client = new Client({ intents: 0, waitForGuilds: true });

    webhookService.setFluxerClient(client);

    const messageRelay = new FluxerToDiscordMessageRelay({
        linkService,
        webhookService,
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
        new ChannelLinkFluxerCommandHandler(client, linkService, webhookService)
    );
    commandRegistry.registerCommand(
        'listchannels',
        new ListChannelsFluxerCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'unlinkchannel',
        new ChannelUnlinkFluxerCommandHandler(client, linkService)
    );

    client.events
        .Ready(() => {
            logger.info('Fluxer bot is ready!');
            logger.info(`Fluxer bot is in ${client.guilds.size} guilds`);
        })
        .events.Error((error) => {
            logger.error('Fluxer client error:', error);
        })
        .events.MessageDelete(async (message) => {
            console.log('Message deleted:', message.id);

            const linkedMessage = await linkService.getMessageLinkByDiscordMessageId(message.id);
            if (!linkedMessage) return;

            console.log('Found linked message:', linkedMessage);

            const linkedChannel = await linkService.getChannelLinkById(linkedMessage.channelLinkId);
            if (!linkedChannel) return;

            console.log('Found linked channel:', linkedChannel);

            const webhook = await webhookService.getDiscordWebhook(
                linkedChannel.discordWebhookId,
                linkedChannel.discordWebhookToken
            );
            if (!webhook) {
                logger.warn(
                    `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message deletion`
                );
                return;
            }

            try {
                await webhook.deleteMessage(linkedMessage.discordMessageId);
            } catch (error) {
                logger.error('Error relaying message deletion to Discord:', error);
            }
        })
        .events.MessageCreate(async (message) => {
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

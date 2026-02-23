import { Client, Message, TextChannel } from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import PingFluxerCommandHandler from './commands/fluxer/handlers/PingFluxerCommandHandler';
import { isCommandString, parseCommandString } from './commands/parseCommandString';
import WebhooktestFluxerCommandHandler from './commands/fluxer/handlers/WebhooktestFluxerCommandHandler';
import './utils/env';
import logger from './utils/logging/logger';
import FluxerCommandHandler from './commands/fluxer/FluxerCommandHandler';
import { COMMAND_PREFIX } from './utils/env';
import GuildLinkFluxerCommandHandler from './commands/fluxer/handlers/GuildLinkFluxerCommandHandler';
import { LinkService } from './services/LinkService';
import ChannelLinkFluxerCommandHandler from './commands/fluxer/handlers/ChannelLinkFluxerCommandHandler';
import ListChannelsFluxerCommandHandler from './commands/fluxer/handlers/ListChannelsFluxerCommandHandler';
import { WebhookService } from './services/WebhookService';

const relayMessage = async (
    message: Message,
    linkService: LinkService,
    webhookService: WebhookService
) => {
    const linkedChannel = await linkService.getChannelLinkByFluxerChannelId(message.channelId);
    if (!linkedChannel) return;

    try {
        const webhook = await webhookService.getDiscordWebhook(
            linkedChannel.discordWebhookId,
            linkedChannel.discordWebhookToken
        );
        if (!webhook) {
            logger.warn(
                `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message`
            );
            return;
        }

        await webhookService.sendMessageViaDiscordWebhook(webhook, {
            content: message.content,
            username: message.author.username,
            avatarURL: message.author.avatarURL() || '',
        });
    } catch (error) {
        logger.error('Error relaying message to Discord:', error);
    }
};

const startFluxerClient = async ({
    linkService,
    webhookService,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
}): Promise<Client> => {
    const client = new Client({ intents: 0, waitForGuilds: true });

    webhookService.setFluxerClient(client);

    const commandRegistry = new CommandRegistry<FluxerCommandHandler>();
    commandRegistry.registerCommand('ping', new PingFluxerCommandHandler(client));
    commandRegistry.registerCommand('webhooktest', new WebhooktestFluxerCommandHandler(client));
    commandRegistry.registerCommand(
        'guildlink',
        new GuildLinkFluxerCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'channellink',
        new ChannelLinkFluxerCommandHandler(client, linkService, webhookService)
    );
    commandRegistry.registerCommand(
        'listchannels',
        new ListChannelsFluxerCommandHandler(client, linkService)
    );

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
                    await message.reply(`Unknown command: \`${command}\``);
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
                await relayMessage(message, linkService, webhookService);
            }
        });

    await client.login(process.env.FLUXER_BOT_TOKEN!);

    return client;
};

export default startFluxerClient;

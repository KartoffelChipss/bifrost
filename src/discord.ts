import { Client, GatewayIntentBits, Partials, TextChannel } from 'discord.js';
import { COMMAND_PREFIX, DISCORD_BOT_TOKEN } from './utils/env';
import logger from './utils/logging/logger';
import CommandRegistry from './commands/CommandRegistry';
import DiscordCommandHandler from './commands/discord/DiscordCommandHandler';
import { isCommandString, parseCommandString } from './commands/parseCommandString';
import PingDiscordCommandHandler from './commands/discord/handlers/PingDiscordCommandHandler';
import { LinkService } from './services/LinkService';
import GuildLinkDiscordCommandHandler from './commands/discord/handlers/GuildLinkDiscordCommandHandler';
import GuildUnlinkDiscordCommandHandler from './commands/discord/handlers/GuildUnlinkDiscordCommandHandler';
import ChannelLinkDiscordCommandHandler from './commands/discord/handlers/ChannelLinkDiscordCommandHandler';
import ListChannelsDiscordCommandHandler from './commands/discord/handlers/ListChannelsDiscordCommandHandler';
import ChannelUnlinkDiscordCommandHandler from './commands/discord/handlers/ChannelUnlinkDiscordCommandHandler';
import { WebhookService } from './services/WebhookService';
import DiscordToFluxerMessageRelay from './services/messageRelay/DiscordToFluxerMessageRelay';
import HelpDiscordCommandHandler from './commands/discord/handlers/HelpDiscordCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import DiscordMessageTransformer from './services/messageTransformer/DiscordMessageTranformer';

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
        presence: {
            status: 'online',
            activities: [
                {
                    name: 'Bridging to Fluxer',
                    type: 0,
                },
            ],
        },
    });

    webhookService.setDiscordClient(client);
    healthCheckService.setDiscordClient(client);
    discordEntityResolver.setDiscordClient(client);

    const messageTransformer = new DiscordMessageTransformer();
    const messageRelay = new DiscordToFluxerMessageRelay({
        linkService,
        webhookService,
        messageTransformer,
    });

    const commandRegistry = new CommandRegistry<DiscordCommandHandler>();
    commandRegistry.registerCommand('ping', new PingDiscordCommandHandler(client));
    commandRegistry.registerCommand('help', new HelpDiscordCommandHandler(client));
    commandRegistry.registerCommand(
        'linkguild',
        new GuildLinkDiscordCommandHandler(client, linkService, fluxerEntityResolver)
    );
    commandRegistry.registerCommand(
        'unlinkguild',
        new GuildUnlinkDiscordCommandHandler(client, linkService)
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

    // client.on('messageUpdate', async (oldMessage, newMessage) => {
    //     if (!newMessage.inGuild()) return;

    //     const messageLink = await linkService.getMessageLinkByDiscordMessageId(newMessage.id);
    //     if (!messageLink) return;

    //     const channelLink = await linkService.getChannelLinkById(messageLink.channelLinkId);
    //     if (!channelLink) return;

    //     const guildLink = await linkService.getGuildLinkById(channelLink.guildLinkId);
    //     if (!guildLink) return;

    //     const msg = await fluxerEntityResolver.fetchMessage(
    //         guildLink.fluxerGuildId,
    //         channelLink.fluxerChannelId,
    //         messageLink.fluxerMessageId
    //     );

    //     if (!msg) {
    //         logger.error(
    //             'Could not find linked Fluxer message to edit for Discord message ID:',
    //             newMessage.id
    //         );
    //         return;
    //     }

    //     try {
    //         await msg.edit({
    //             content: newMessage.content,
    //         });
    //     } catch (error) {
    //         logger.error('Error editing message in Fluxer:', error);
    //     }
    // });

    client.on('messageCreate', async (message) => {
        if (message.author.id === client.user?.id) return;
        if (!message.inGuild()) return;

        // prevent loops by ignoring messages sent by webhooks that were created by this bot
        if (message.webhookId) {
            const webhookLink = await linkService.getChannelLinkByDiscordChannelId(
                message.channelId
            );
            if (webhookLink && webhookLink.discordWebhookId === message.webhookId) {
                logger.info(
                    `Ignoring message from webhook ${message.webhookId} in channel ${message.channelId} to prevent loop`
                );
                return;
            }
        }

        if (isCommandString(message.content, COMMAND_PREFIX) && !message.author.bot) {
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

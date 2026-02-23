import {
    Client,
    GatewayIntentBits,
    Message,
    OmitPartialGroupDMChannel,
    Partials,
    TextChannel,
} from 'discord.js';
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
import ListChannelsDiscordCommandHandler from './commands/discord/handlers/ListChannelsDiscordCommandHandler';
import ChannelUnlinkDiscordCommandHandler from './commands/discord/handlers/ChannelUnlinkDiscordCommandHandler';
import { WebhookService } from './services/WebhookService';
import { buildDiscordStickerUrl } from './utils/buildStickerUrl';
import { sanitizeMentions } from './utils/sanitizeMentions';
import { getPollMessage } from './utils/pollMessageFormatter';

const stickerFormatToExtension = (format: number): string => {
    switch (format) {
        case 1:
            return 'png';
        case 2:
            return 'png';
        case 3:
            return 'json';
        case 4:
            return 'gif';
        default:
            return 'png';
    }
};

const relayMessage = async (
    message: OmitPartialGroupDMChannel<Message<boolean>>,
    linkService: LinkService,
    webhookService: WebhookService
) => {
    const linkedChannel = await linkService.getChannelLinkByDiscordChannelId(message.channelId);
    if (!linkedChannel) return;

    try {
        const webhook = await webhookService.getFluxerWebhook(
            linkedChannel.fluxerWebhookId,
            linkedChannel.fluxerWebhookToken
        );
        if (!webhook) {
            logger.warn(
                `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message`
            );
            return;
        }

        const sanitizedContent = sanitizeMentions(message.content, {
            resolveUser: (id) => {
                const user = message.client.users.cache.get(id);
                return user ? user.username : null;
            },
            resolveRole: (id) => {
                if (!message.guild) return null;
                const role = message.guild.roles.cache.get(id);
                return role ? role.name : null;
            },
            resolveChannel: (id) => {
                const channel = message.client.channels.cache.get(id);
                return channel
                    ? channel instanceof TextChannel
                        ? channel.name
                        : channel.id
                    : null;
            },
        });

        const attachments = message.attachments.map((attachment) => ({
            url: attachment.url,
            name: attachment.name || 'attachment',
            spoiler: attachment.spoiler,
        }));

        message.stickers.forEach((sticker) => {
            attachments.push({
                url: buildDiscordStickerUrl(sticker.id, 160),
                name: sticker.name + '.' + stickerFormatToExtension(sticker.format),
                spoiler: false,
            });
        });

        const isPollPresent =
            message.poll &&
            message.poll.question.text &&
            message.poll.answers.some((a) => a.text) &&
            message.poll.expiresTimestamp;

        const messageContent = isPollPresent
            ? getPollMessage(
                  message.poll!.question.text!,
                  message.poll!.answers.map((a) => a.text).filter((t): t is string => !!t),
                  message.poll!.expiresTimestamp!
              )
            : sanitizedContent;

        await webhookService.sendMessageViaFluxerWebhook(webhook, {
            content: messageContent,
            username: message.author.username,
            avatarURL: message.author.avatarURL() || '',
            attachments: attachments,
        });
    } catch (error) {
        logger.error('Error relaying message to Fluxer:', error);
    }
};

const startDiscordClient = async ({
    linkService,
    webhookService,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
}): Promise<Client> => {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel],
    });

    webhookService.setDiscordClient(client);

    const commandRegistry = new CommandRegistry<DiscordCommandHandler>();
    commandRegistry.registerCommand('ping', new PingDiscordCommandHandler(client));
    commandRegistry.registerCommand('webhooktest', new WebhooktestDiscordCommandHandler(client));
    commandRegistry.registerCommand(
        'linkguild',
        new GuildLinkDiscordCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'linkchannel',
        new ChannelLinkDiscordCommandHandler(client, linkService, webhookService)
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
    });

    client.on('error', (error) => {
        logger.error('Discord client error:', error);
    });

    client.on('messageCreate', async (message) => {
        if (message.author.id === client.user?.id) return;
        if (message.author.bot) return;

        if (!message.inGuild()) return;

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
                logger.error(`Error executing discord command "${command}":`, error);
            }
        }

        if (
            message.channel instanceof TextChannel &&
            !isCommandString(message.content, COMMAND_PREFIX)
        ) {
            await relayMessage(message, linkService, webhookService);
        }
    });

    await client.login(DISCORD_BOT_TOKEN);

    return client;
};

export default startDiscordClient;

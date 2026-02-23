import { Client, Message, MessageAttachmentFlags, TextChannel } from '@fluxerjs/core';
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
import ChannelUnlinkFluxerCommandHandler from './commands/fluxer/handlers/ChannelUnlinkFluxerCommandHandler';
import { WebhookService } from './services/WebhookService';
import { buildFluxerStickerUrl } from './utils/buildStickerUrl';
import { breakMentions, escapeMentions, sanitizeMentions } from './utils/sanitizeMentions';

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

        console.log('Relaying message to Discord:', message.content);

        const sanitizedContent = breakMentions(
            sanitizeMentions(message.content, {
                resolveUser: (id) => {
                    const user = message.client.users.get(id);
                    return user ? user.username : null;
                },
                resolveRole: (id) => {
                    if (!message.guild) return null;
                    const role = message.guild.roles.get(id);
                    return role ? role.name : null;
                },
                resolveChannel: (id) => {
                    const channel = message.client.channels.get(id);
                    return channel ? channel.name : null;
                },
            })
        );

        console.log('Sanitized content:', sanitizedContent);

        const attachments = message.attachments
            .filter(
                (attachment) =>
                    attachment.url !== null &&
                    attachment.url !== undefined &&
                    attachment.url !== '' &&
                    !!attachment.url
            )
            .map((attachment) => ({
                url: attachment.url!,
                name: attachment.filename || 'attachment',
                spoiler:
                    attachment.flags && attachment.flags & MessageAttachmentFlags.IS_SPOILER
                        ? true
                        : false,
            }));

        message.stickers.forEach((sticker) => {
            attachments.push({
                url: buildFluxerStickerUrl(sticker.id, sticker.animated || false, 160),
                name: sticker.name + '.webp',
                spoiler: false,
            });
        });

        await webhookService.sendMessageViaDiscordWebhook(webhook, {
            content: sanitizedContent,
            username: message.author.username,
            avatarURL: message.author.avatarURL() || '',
            attachments,
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

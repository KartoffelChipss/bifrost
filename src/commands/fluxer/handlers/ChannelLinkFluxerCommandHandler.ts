import { Client, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getUsageMessage } from '../../../utils/usageMessage';
import logger from '../../../utils/logging/logger';

export default class ChannelLinkFluxerCommandHandler extends FluxerCommandHandler {
    private readonly linkService: LinkService;

    constructor(client: Client, linkService: LinkService) {
        super(client);
        this.linkService = linkService;
    }

    public async handleCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void> {
        if (args.length < 1 || args[0] == 'help') {
            const usage = getUsageMessage(
                command,
                ['<discord-channel-id>'],
                'Links the current Fluxer channel to a Discord channel.'
            );
            await message.reply(usage);
            return;
        }

        const discordChannelId = args[0];

        let guildLink = null;

        try {
            guildLink = await this.linkService.getGuildLinkForFluxerGuild(message.guildId!);
            if (!guildLink) {
                throw new Error('Guild not linked');
            }
        } catch (error: any) {
            await message.reply(`Failed to get guild link: ${error.message}`);
            return;
        }

        try {
            await this.linkService.createChannelLink({
                guildLinkId: guildLink.id,
                discordChannelId,
                fluxerChannelId: message.channelId,
                discordWebhookId: '__NONE__',
                discordWebhookToken: '__NONE__',
                fluxerWebhookId: '__NONE__',
                fluxerWebhookToken: '__NONE__',
            });
            await message.reply(
                `Successfully linked this Fluxer channel to Discord channel ID \`${discordChannelId}\`.`
            );
        } catch (error: any) {
            await message.reply(`Failed to create channel link: ${error.message}`);
            logger.error('Error creating channel link', { error });
        }
    }
}

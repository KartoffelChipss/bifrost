import { Message, MessageType, OmitPartialGroupDMChannel } from 'discord.js';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkService } from '../LinkService';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import MessageTransformer from '../messageTransformer/MessageTransformer';

export default class DiscordToFluxerMessageRelay extends MessageRelay<
    OmitPartialGroupDMChannel<Message<boolean>>
> {
    private readonly fluxerEntityResolver: FluxerEntityResolver;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        fluxerEntityResolver,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<
            OmitPartialGroupDMChannel<Message<boolean>>,
            WebhookMessageData
        >;
        fluxerEntityResolver: FluxerEntityResolver;
    }) {
        super({
            linkService,
            webhookService,
            messageTransformer,
        });
        this.fluxerEntityResolver = fluxerEntityResolver;
    }

    public async relayMessage(
        message: OmitPartialGroupDMChannel<Message<boolean>>
    ): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        const linkedChannel =
            await linkService.getChannelLinkByDiscordChannelId(
                message.channelId
            );
        if (!linkedChannel) return;
        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        // Build payload before attempting send so it can be queued on failure
        let msg: WebhookMessageData;
        if (message.type === MessageType.UserJoin) {
            msg = {
                content: formatJoinMessage(message.author.username, 'discord'),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        } else {
            msg = await this.getMessageTransformer().transformMessage(message);
        }

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

            if (message.type === MessageType.UserJoin) {
                await webhookService.sendMessageViaFluxerWebhook(webhook, {
                    content: formatJoinMessage(
                        message.author.username,
                        'discord'
                    ),
                    username: message.client.user?.username || 'Bifröst',
                    avatarURL: message.client.user?.avatarURL() || '',
                });
                this.metricsService?.messagesRelayed.inc({ direction: 'discord_to_fluxer' });
                return;
            }

            const fluxerEmojis = await this.fluxerEntityResolver.fetchEmojis(
                guildLink.fluxerGuildId
            );

            const msg = await this.getMessageTransformer().transformMessage(
                message,
                fluxerEmojis
            );

            const { messageId: webhookMessageId } =
                await webhookService.sendMessageViaFluxerWebhook(webhook, msg);

            if (message.type !== MessageType.UserJoin) {
                await linkService.createMessageLink({
                    discordMessageId: message.id,
                    fluxerMessageId: webhookMessageId,
                    guildLinkId: linkedChannel.guildLinkId,
                    channelLinkId: linkedChannel.id,
                });
            }
            this.metricsService?.messagesRelayed.inc({ direction: 'discord_to_fluxer' });
        } catch (error) {
            logger.error(
                'Failed relaying Discord message to Fluxer',
                {
                    source: 'DiscordToFluxerMessageRelay',
                    discordMessageId: message.id,
                    discordGuildId: message.guildId,
                    discordChannelId: message.channelId,
                    linkId: linkedChannel.linkId,
                    channelLinkId: linkedChannel.id,
                    guildLinkId: linkedChannel.guildLinkId,
                },
                error
            );
        }
    }
}

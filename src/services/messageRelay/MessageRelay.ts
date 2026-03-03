import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import MetricsService from '../MetricsService';

export default abstract class MessageRelay<RelayMessage> {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;
    private readonly messageTransformer: MessageTransformer<
        RelayMessage,
        WebhookMessageData
    >;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<
            RelayMessage,
            WebhookMessageData
        >;
    }) {
        this.linkService = linkService;
        this.webhookService = webhookService;
        this.messageTransformer = messageTransformer;
        this.metricsService = metricsService ?? null;
    }

    public abstract relayMessage(message: RelayMessage): Promise<void>;

    protected getLinkService(): LinkService {
        return this.linkService;
    }

    protected getWebhookService(): WebhookService {
        return this.webhookService;
    }

    protected getMessageTransformer(): MessageTransformer<
        RelayMessage,
        WebhookMessageData
    > {
        return this.messageTransformer;
    }
}

import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import MetricsService from '../MetricsService';
import MessageQueueService from '../MessageQueueService';

export default abstract class MessageRelay<RelayMessage> {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;
    private readonly messageTransformer: MessageTransformer<RelayMessage, WebhookMessageData>;
    protected readonly metricsService: MetricsService | null;
    protected readonly queueService: MessageQueueService | null;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<RelayMessage, WebhookMessageData>;
        metricsService?: MetricsService;
        queueService?: MessageQueueService;
    }) {
        this.linkService = linkService;
        this.webhookService = webhookService;
        this.messageTransformer = messageTransformer;
        this.metricsService = metricsService ?? null;
        this.queueService = queueService ?? null;
    }

    public abstract relayMessage(message: RelayMessage): Promise<void>;

    protected getLinkService(): LinkService {
        return this.linkService;
    }

    protected getWebhookService(): WebhookService {
        return this.webhookService;
    }

    protected getMessageTransformer(): MessageTransformer<RelayMessage, WebhookMessageData> {
        return this.messageTransformer;
    }
}

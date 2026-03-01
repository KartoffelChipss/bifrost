import { LinkService } from '../LinkService';
import { WebhookService } from '../WebhookService';

export default abstract class MessageRelay<T> {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;

    constructor({
        linkService,
        webhookService,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
    }) {
        this.linkService = linkService;
        this.webhookService = webhookService;
    }

    public abstract relayMessage(message: T): Promise<void>;

    protected getLinkService(): LinkService {
        return this.linkService;
    }

    protected getWebhookService(): WebhookService {
        return this.webhookService;
    }
}

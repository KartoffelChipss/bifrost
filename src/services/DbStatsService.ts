import { ChannelLinkRepository } from '../db/repositories/ChannelLinkRepository';
import { MessageLinkRepository } from '../db/repositories/MessageLinkRepository';

export class DbStatsService {
    constructor(
        private readonly channelLinkRepository: ChannelLinkRepository,
        private readonly messageLinkRepository: MessageLinkRepository
    ) {}

    async getStats() {
        const channelLinksCount =
            await this.channelLinkRepository.getChannelLinksCount();

        const messageLinksCount =
            await this.messageLinkRepository.getMessageLinksCount();

        return {
            channelLinksCount,
            messageLinksCount,
        };
    }
}

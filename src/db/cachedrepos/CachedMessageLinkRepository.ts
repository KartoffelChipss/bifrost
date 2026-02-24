import { LRUCache } from 'lru-cache';
import { MessageLink } from '../entities/MessageLink';
import { MessageLinkRepository } from '../repositories/MessageLinkRepository';

export class CachedMessageLinkRepository implements MessageLinkRepository {
    private cache: LRUCache<string, MessageLink>;

    constructor(
        private readonly repository: MessageLinkRepository,
        maxEntries = 15_000
    ) {
        this.cache = new LRUCache<string, MessageLink>({
            max: maxEntries,
        });
    }

    private idKey(id: string) {
        return `id:${id}`;
    }

    private discordKey(discordMessageId: string) {
        return `discord:${discordMessageId}`;
    }

    private fluxerKey(fluxerMessageId: string) {
        return `fluxer:${fluxerMessageId}`;
    }

    async createMessageLink(
        guildLinkId: string,
        channelLinkId: string,
        discordMessageId: string,
        fluxerMessageId: string
    ): Promise<void> {
        await this.repository.createMessageLink(
            guildLinkId,
            channelLinkId,
            discordMessageId,
            fluxerMessageId
        );

        const created = await this.repository.getMessageLinkByDiscordMessageId(discordMessageId);

        if (created) {
            this.primeCache(created);
        }
    }

    async deleteMessageLink(id: string): Promise<void> {
        const existing = await this.repository.getMessageLinkById(id);

        await this.repository.deleteMessageLink(id);

        if (!existing) return;

        this.cache.delete(this.idKey(existing.id));
        this.cache.delete(this.discordKey(existing.discordMessageId));
        this.cache.delete(this.fluxerKey(existing.fluxerMessageId));
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await this.repository.deleteByGuildLinkId(guildLinkId);

        for (const [key, value] of this.cache.entries()) {
            if (value.guildLinkId === guildLinkId) {
                this.cache.delete(key);
                this.cache.delete(this.idKey(value.id));
                this.cache.delete(this.discordKey(value.discordMessageId));
                this.cache.delete(this.fluxerKey(value.fluxerMessageId));
            }
        }
    }

    async getMessageLinkById(id: string): Promise<MessageLink | null> {
        const key = this.idKey(id);
        const cached = this.cache.get(key);
        if (cached) return cached;

        const result = await this.repository.getMessageLinkById(id);
        if (!result) return null;

        this.primeCache(result);
        return result;
    }

    async getMessageLinkByDiscordMessageId(discordMessageId: string): Promise<MessageLink | null> {
        const key = this.discordKey(discordMessageId);
        const cached = this.cache.get(key);
        if (cached) return cached;

        const result = await this.repository.getMessageLinkByDiscordMessageId(discordMessageId);

        if (!result) return null;

        this.primeCache(result);
        return result;
    }

    async getMessageLinkByFluxerMessageId(fluxerMessageId: string): Promise<MessageLink | null> {
        const key = this.fluxerKey(fluxerMessageId);
        const cached = this.cache.get(key);
        if (cached) return cached;

        const result = await this.repository.getMessageLinkByFluxerMessageId(fluxerMessageId);

        if (!result) return null;

        this.primeCache(result);
        return result;
    }

    private primeCache(entity: MessageLink) {
        this.cache.set(this.idKey(entity.id), entity);
        this.cache.set(this.discordKey(entity.discordMessageId), entity);
        this.cache.set(this.fluxerKey(entity.fluxerMessageId), entity);
    }
}

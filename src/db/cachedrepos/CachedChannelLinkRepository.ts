import NodeCache from 'node-cache';
import { ChannelLink } from '../entities/ChannelLink';
import { ChannelLinkRepository } from '../repositories/ChannelLinkRepository';

export class CachedChannelLinkRepository implements ChannelLinkRepository {
    private cache: NodeCache;

    constructor(
        private readonly repository: ChannelLinkRepository,
        ttlSeconds: number
    ) {
        this.cache = new NodeCache({ stdTTL: ttlSeconds });
    }

    private guildKey(guildLinkId: string, linkId: string) {
        return `guild:${guildLinkId}:link:${linkId}`;
    }

    private guildAllKey(guildLinkId: string) {
        return `guild:${guildLinkId}:all`;
    }

    private discordKey(discordChannelId: string) {
        return `discord:${discordChannelId}`;
    }

    private fluxerKey(fluxerChannelId: string) {
        return `fluxer:${fluxerChannelId}`;
    }

    async create(data: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        discordWebhookId: string;
        discordWebhookToken: string;
        fluxerWebhookId: string;
        fluxerWebhookToken: string;
    }): Promise<ChannelLink> {
        const created = await this.repository.create(data);

        this.cache.set(this.guildKey(created.guildLinkId, created.linkId), created);
        this.cache.set(this.discordKey(created.discordChannelId), created);
        this.cache.set(this.fluxerKey(created.fluxerChannelId), created);

        this.cache.del(this.guildAllKey(created.guildLinkId));

        return created;
    }

    async findByGuildAndLinkId(guildLinkId: string, linkId: string): Promise<ChannelLink | null> {
        const key = this.guildKey(guildLinkId, linkId);

        const cached = this.cache.get<ChannelLink>(key);
        if (cached) return cached;

        const result = await this.repository.findByGuildAndLinkId(guildLinkId, linkId);

        if (result) {
            this.cache.set(key, result);
        }

        return result;
    }

    async findAllByGuild(guildLinkId: string): Promise<ChannelLink[]> {
        const key = this.guildAllKey(guildLinkId);

        const cached = this.cache.get<ChannelLink[]>(key);
        if (cached) return cached;

        const result = await this.repository.findAllByGuild(guildLinkId);

        this.cache.set(key, result);

        return result;
    }

    async findById(id: string): Promise<ChannelLink | null> {
        const cached = this.cache.get<ChannelLink>(id);
        if (cached) return cached;

        const result = await this.repository.findById(id);
        if (result) {
            this.cache.set(id, result);
        }
        return result;
    }

    async findByDiscordChannelId(discordChannelId: string): Promise<ChannelLink | null> {
        const key = this.discordKey(discordChannelId);

        const cached = this.cache.get<ChannelLink>(key);
        if (cached) return cached;

        const result = await this.repository.findByDiscordChannelId(discordChannelId);

        if (result) {
            this.cache.set(key, result);
        }

        return result;
    }

    async findByFluxerChannelId(fluxerChannelId: string): Promise<ChannelLink | null> {
        const key = this.fluxerKey(fluxerChannelId);

        const cached = this.cache.get<ChannelLink>(key);
        if (cached) return cached;

        const result = await this.repository.findByFluxerChannelId(fluxerChannelId);

        if (result) {
            this.cache.set(key, result);
        }

        return result;
    }

    async deleteById(id: string): Promise<void> {
        const existing = await this.repository.findById(id);
        if (!existing) return;

        await this.repository.deleteById(id);

        this.cache.del(this.guildKey(existing.guildLinkId, existing.linkId));
        this.cache.del(this.discordKey(existing.discordChannelId));
        this.cache.del(this.fluxerKey(existing.fluxerChannelId));
        this.cache.del(this.guildAllKey(existing.guildLinkId));
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        const existingLinks = await this.repository.findAllByGuild(guildLinkId);

        await this.repository.deleteByGuildLinkId(guildLinkId);

        existingLinks.forEach((link) => {
            this.cache.del(this.guildKey(link.guildLinkId, link.linkId));
            this.cache.del(this.discordKey(link.discordChannelId));
            this.cache.del(this.fluxerKey(link.fluxerChannelId));
        });
        this.cache.del(this.guildAllKey(guildLinkId));
    }
}

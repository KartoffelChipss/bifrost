import NodeCache from 'node-cache';
import { GuildLink } from '../entities/GuildLink';
import { GuildLinkRepository } from '../repositories/GuildLinkRepository';

export class CachedGuildLinkRepository implements GuildLinkRepository {
    private cache: NodeCache;

    constructor(
        private readonly repository: GuildLinkRepository,
        ttlSeconds: number
    ) {
        this.cache = new NodeCache({ stdTTL: ttlSeconds });
    }

    private idKey(id: string) {
        return `id:${id}`;
    }

    private discordKey(discordGuildId: string) {
        return `discord:${discordGuildId}`;
    }

    private fluxerKey(fluxerGuildId: string) {
        return `fluxer:${fluxerGuildId}`;
    }

    async findById(id: string): Promise<GuildLink | null> {
        const key = this.idKey(id);

        const cached = this.cache.get<GuildLink>(key);
        if (cached) return cached;

        const result = await this.repository.findById(id);
        if (!result) return null;

        this.primeCache(result);
        return result;
    }

    async findByDiscordGuildId(discordGuildId: string): Promise<GuildLink | null> {
        const key = this.discordKey(discordGuildId);

        const cached = this.cache.get<GuildLink>(key);
        if (cached) return cached;

        const result = await this.repository.findByDiscordGuildId(discordGuildId);
        if (!result) return null;

        this.primeCache(result);
        return result;
    }

    async findByFluxerGuildId(fluxerGuildId: string): Promise<GuildLink | null> {
        const key = this.fluxerKey(fluxerGuildId);

        const cached = this.cache.get<GuildLink>(key);
        if (cached) return cached;

        const result = await this.repository.findByFluxerGuildId(fluxerGuildId);
        if (!result) return null;

        this.primeCache(result);
        return result;
    }

    async create(discordGuildId: string, fluxerGuildId: string): Promise<GuildLink> {
        const created = await this.repository.create(discordGuildId, fluxerGuildId);

        this.primeCache(created);

        return created;
    }

    async deleteById(id: string): Promise<void> {
        const existing = await this.repository.findById(id);
        if (!existing) return;

        await this.repository.deleteById(id);

        this.cache.del(this.idKey(existing.id));
        this.cache.del(this.discordKey(existing.discordGuildId));
        this.cache.del(this.fluxerKey(existing.fluxerGuildId));
    }

    private primeCache(entity: GuildLink) {
        this.cache.set(this.idKey(entity.id), entity);
        this.cache.set(this.discordKey(entity.discordGuildId), entity);
        this.cache.set(this.fluxerKey(entity.fluxerGuildId), entity);
    }
}

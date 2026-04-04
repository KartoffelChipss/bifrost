import { GuildLink } from '../entities/GuildLink';

export interface GuildLinkRepository {
    create(discordGuildId: string, fluxerGuildId: string): Promise<GuildLink>;

    findById(id: string): Promise<GuildLink | null>;

    findByDiscordGuildId(discordGuildId: string): Promise<GuildLink | null>;

    findByFluxerGuildId(fluxerGuildId: string): Promise<GuildLink | null>;

    findAll(): Promise<GuildLink[]>;

    deleteById(id: string): Promise<void>;
}

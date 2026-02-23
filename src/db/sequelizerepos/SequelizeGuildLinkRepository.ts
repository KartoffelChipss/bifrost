import { GuildLink } from '../entities/GuildLink';
import { GuildLinkModel } from '../models';
import { GuildLinkRepository } from '../repositories/GuildLinkRepository';

export class SequelizeGuildLinkRepository implements GuildLinkRepository {
    async findById(id: string) {
        const model = await GuildLinkModel.findOne({
            where: { id },
        });

        if (!model) return null;

        return model.toJSON() as GuildLink;
    }

    async findByDiscordGuildId(discordGuildId: string) {
        const model = await GuildLinkModel.findOne({
            where: { discordGuildId },
        });

        if (!model) return null;

        return model.toJSON() as GuildLink;
    }

    async findByFluxerGuildId(fluxerGuildId: string) {
        const model = await GuildLinkModel.findOne({
            where: { fluxerGuildId },
        });

        if (!model) return null;

        return model.toJSON() as GuildLink;
    }

    async create(discordGuildId: string, fluxerGuildId: string) {
        const model = await GuildLinkModel.create({
            id: crypto.randomUUID(),
            discordGuildId,
            fluxerGuildId,
        });

        return model.toJSON() as GuildLink;
    }

    async deleteById(id: string) {
        await GuildLinkModel.destroy({
            where: { id },
        });
    }
}

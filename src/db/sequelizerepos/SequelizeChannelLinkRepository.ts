import { nanoid } from 'nanoid';
import { ChannelLink } from '../entities/ChannelLink';
import { ChannelLinkModel } from '../models';
import { ChannelLinkRepository } from '../repositories/ChannelLinkRepository';

export class SequelizeChannelLinkRepository implements ChannelLinkRepository {
    async create(data: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        discordWebhookId: string;
        discordWebhookToken: string;
        fluxerWebhookId: string;
        fluxerWebhookToken: string;
    }): Promise<ChannelLink> {
        const model = await ChannelLinkModel.create({
            id: crypto.randomUUID(),
            linkId: nanoid(10),
            ...data,
        });

        if (!model) {
            throw new Error('Failed to create channel link');
        }

        return model.toJSON() as ChannelLink;
    }

    async findByGuildAndLinkId(guildLinkId: string, linkId: string): Promise<ChannelLink | null> {
        const model = await ChannelLinkModel.findOne({
            where: { guildLinkId, linkId },
        });

        if (!model) return null;

        return model.toJSON() as ChannelLink;
    }

    async findAllByGuild(guildLinkId: string): Promise<ChannelLink[]> {
        const models = await ChannelLinkModel.findAll({
            where: { guildLinkId },
        });

        return models.map((m) => m.toJSON() as ChannelLink);
    }

    async findById(id: string): Promise<ChannelLink | null> {
        const model = await ChannelLinkModel.findOne({
            where: { id },
        });

        if (!model) return null;

        return model.toJSON() as ChannelLink;
    }

    async findByDiscordChannelId(discordChannelId: string): Promise<ChannelLink | null> {
        const model = await ChannelLinkModel.findOne({
            where: { discordChannelId },
        });

        if (!model) return null;

        return model.toJSON() as ChannelLink;
    }

    async findByFluxerChannelId(fluxerChannelId: string): Promise<ChannelLink | null> {
        const model = await ChannelLinkModel.findOne({
            where: { fluxerChannelId },
        });

        if (!model) return null;

        return model.toJSON() as ChannelLink;
    }

    async deleteById(id: string): Promise<void> {
        await ChannelLinkModel.destroy({
            where: { id },
        });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await ChannelLinkModel.destroy({
            where: { guildLinkId },
        });
    }
}

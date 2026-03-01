import { randomUUID } from 'crypto';
import { MessageLink } from '../entities/MessageLink';
import { MessageLinkRepository } from '../repositories/MessageLinkRepository';
import { MessageLinkModel } from '../models/MessageLinkModel';

export class SequelizeMessageLinkRepository implements MessageLinkRepository {
    async createMessageLink(
        guildLinkId: string,
        channelLinkId: string,
        discordMessageId: string,
        fluxerMessageId: string
    ): Promise<void> {
        await MessageLinkModel.create({
            id: randomUUID(),
            guildLinkId,
            channelLinkId,
            discordMessageId,
            fluxerMessageId,
        });
    }

    async getMessageLinkById(id: string): Promise<MessageLink | null> {
        const model = await MessageLinkModel.findByPk(id);

        if (!model) return null;

        return model.toJSON() as MessageLink;
    }

    async getMessageLinkByDiscordMessageId(discordMessageId: string): Promise<MessageLink | null> {
        const model = await MessageLinkModel.findOne({
            where: { discordMessageId },
        });

        if (!model) return null;

        return model.toJSON() as MessageLink;
    }

    async getMessageLinkByFluxerMessageId(fluxerMessageId: string): Promise<MessageLink | null> {
        const model = await MessageLinkModel.findOne({
            where: { fluxerMessageId },
        });

        if (!model) return null;

        return model.toJSON() as MessageLink;
    }

    async deleteMessageLink(id: string): Promise<void> {
        await MessageLinkModel.destroy({
            where: { id },
        });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await MessageLinkModel.destroy({
            where: { guildLinkId },
        });
    }

    async deleteByChannelLinkId(channelLinkId: string): Promise<void> {
        await MessageLinkModel.destroy({
            where: { channelLinkId },
        });
    }
}

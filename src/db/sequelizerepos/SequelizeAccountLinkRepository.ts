import { randomUUID } from 'crypto';
import { AccountLink } from '../entities/AccountLink';
import { AccountLinkModel } from '../models/AccountLinkModel';
import { AccountLinkRepository } from '../repositories/AccountLinkRepository';

export class SequelizeAccountLinkRepository implements AccountLinkRepository {
    async list(): Promise<AccountLink[]> {
        const models = await AccountLinkModel.findAll({
            order: [['createdAt', 'ASC']],
        });
        return models.map((model) => model.toJSON() as AccountLink);
    }

    async create(
        discordUserId: string,
        fluxerUserId: string
    ): Promise<AccountLink> {
        const model = await AccountLinkModel.create({
            id: randomUUID(),
            discordUserId,
            fluxerUserId,
        });
        return model.toJSON() as AccountLink;
    }

    async remove(id: string): Promise<void> {
        await AccountLinkModel.destroy({ where: { id } });
    }

    async findByUserId(
        platform: 'discord' | 'fluxer',
        userId: string
    ): Promise<AccountLink | null> {
        const field = platform === 'discord' ? 'discordUserId' : 'fluxerUserId';
        const model = await AccountLinkModel.findOne({
            where: { [field]: userId },
        });
        return model ? (model.toJSON() as AccountLink) : null;
    }
}

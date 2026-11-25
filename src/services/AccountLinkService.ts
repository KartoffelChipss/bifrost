import { AccountLinkRepository } from '../db/repositories/AccountLinkRepository';

export class AccountLinkService {
    constructor(private readonly accounts: AccountLinkRepository) {}

    list() {
        return this.accounts.list();
    }

    create(discordUserId: string, fluxerUserId: string) {
        return this.accounts.create(discordUserId, fluxerUserId);
    }

    remove(id: string) {
        return this.accounts.remove(id);
    }

    async counterpart(platform: 'discord' | 'fluxer', userId: string) {
        const link = await this.accounts.findByUserId(platform, userId);
        return link
            ? platform === 'discord'
                ? link.fluxerUserId
                : link.discordUserId
            : null;
    }
}

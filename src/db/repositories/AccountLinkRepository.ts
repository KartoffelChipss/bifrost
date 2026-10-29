import { AccountLink } from '../entities/AccountLink';

export interface AccountLinkRepository {
    list(): Promise<AccountLink[]>;
    create(discordUserId: string, fluxerUserId: string): Promise<AccountLink>;
    remove(id: string): Promise<void>;
    findByUserId(
        platform: 'discord' | 'fluxer',
        userId: string
    ): Promise<AccountLink | null>;
}

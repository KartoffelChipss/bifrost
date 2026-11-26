import type { AddonLogger } from '../addons/isolation';
import { isNotFound } from '../guild-sync/notFound';
import { memberFromUser, parseRawMember } from './parse';
import type { PostgresArchiveStore } from './store';
import type { ArchiveSource, RawMessage, RawUser } from './types';

/** A snapshot older than this is taken again. */
export const MEMBER_STALE_MS = 7 * 24 * 60 * 60_000;
/** Authors looked up per page at most; the rest wait for a later page. */
const MAX_LOOKUPS_PER_PAGE = 25;

export interface MemberDeps {
    readonly store: Pick<PostgresArchiveStore, 'membersSeen' | 'saveMember'>;
    readonly source: Pick<ArchiveSource, 'member'>;
    readonly logger: AddonLogger;
    readonly now: () => Date;
}

/** The distinct human authors of a page: webhooks have no member. */
export function pageAuthors(messages: readonly RawMessage[]): RawUser[] {
    const byId = new Map<string, RawUser>();
    for (const m of messages) {
        if (!m.webhook_id) byId.set(m.author.id, m.author);
    }
    return [...byId.values()];
}

/**
 * Keeps a name-and-avatar snapshot of each author: their server nickname
 * and avatars while they are a member, their user profile after they left.
 */
export class MemberSnapshots {
    constructor(private readonly deps: MemberDeps) {}

    /** Takes snapshots of the page's authors that are missing or stale. */
    async refresh(guildId: string, authors: readonly RawUser[]): Promise<void> {
        const now = this.deps.now();
        const ids = authors.map((a) => a.id);
        const seen = await this.deps.store.membersSeen(guildId, ids);
        const stale = authors.filter((a) => {
            const at = seen.get(a.id);
            return !at || now.getTime() - at.getTime() > MEMBER_STALE_MS;
        });
        for (const author of stale.slice(0, MAX_LOOKUPS_PER_PAGE)) {
            await this.take(guildId, author, now);
        }
    }

    private async take(guildId: string, author: RawUser, now: Date) {
        try {
            const raw = await this.deps.source.member(guildId, author.id);
            const parsed = raw === null ? null : parseRawMember(guildId, raw);
            const member = parsed ?? memberFromUser(guildId, author);
            await this.deps.store.saveMember(member, now);
        } catch (error) {
            if (isNotFound(error)) {
                await this.deps.store.saveMember(
                    memberFromUser(guildId, author),
                    now
                );
                return;
            }
            this.deps.logger.warn(
                `[archive] Member ${author.id} not saved: ${describe(error)}`
            );
        }
    }
}

export function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

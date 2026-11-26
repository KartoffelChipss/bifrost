import { isNotFound } from './notFound';

/**
 * Loads a history message's author into the discord.js member cache.
 *
 * discord.js reads `Message.member` from the cache only
 * (`guild.members.resolve(author)`), and a message read over REST brings
 * no member with it. Without this, a copy goes out under the author's
 * global name instead of their server nickname whenever the member was
 * not cached, for example after every restart. With the GuildMembers
 * intent, member updates keep a cached member current.
 */

/** Authors known to have left, kept per process; cleared when full. */
export const MAX_ABSENT_AUTHORS = 10_000;

/** One guild's member cache and its REST lookup. */
export interface GuildMembers {
    readonly guildId: string;
    isCached(userId: string): boolean;
    /** Fetches one member and caches it. Rejects with 404 when absent. */
    fetch(userId: string): Promise<unknown>;
}

export class AuthorMembers {
    private readonly absent = new Set<string>();

    constructor(private readonly warn: (detail: string) => void) {}

    /**
     * Caches `userId`'s member when it is not cached yet. A member who left
     * is remembered, so the import asks once. Any other failure keeps the
     * copy going under the fallback name and is logged.
     */
    async load(members: GuildMembers, userId: string): Promise<void> {
        if (!members.guildId || !userId) return;
        const key = `${members.guildId}:${userId}`;
        if (members.isCached(userId) || this.absent.has(key)) return;
        try {
            await members.fetch(userId);
        } catch (error) {
            if (isNotFound(error)) {
                this.markAbsent(key);
                return;
            }
            this.warn(
                `[history] Member ${userId} not loaded, copying under their global name: ${describe(error)}`
            );
        }
    }

    private markAbsent(key: string): void {
        if (this.absent.size >= MAX_ABSENT_AUTHORS) this.absent.clear();
        this.absent.add(key);
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

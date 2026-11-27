import type { AddonLogger } from '../addons/isolation';
import { snowflakeTime } from '../fluxer-db/keys';
import { copyName, type DiscordNames } from './names';
import type { CopyRef, DueAuthor, PostgresNameStore } from './store';
import type { FluxerNameWriter } from './writer';

/** Copies younger than this also get a live update, so open apps refresh. */
export const LIVE_UPDATE_AGE_MS = 3 * 24 * 60 * 60_000;
/** Live updates per author per pass at most. */
export const MAX_LIVE_UPDATES = 25;
/** Authors handled per server per pass at most. */
export const AUTHORS_PER_PASS = 10;

export interface NameSyncPorts {
    /** The member's names in a Discord server; null when Discord has no such user. */
    names(guildId: string, discordUserId: string): Promise<DiscordNames | null>;
    /**
     * Sends a flags-only edit through the copy's webhook. Fluxer then sends
     * open apps a MESSAGE_UPDATE with the new name, and adds no "(edited)"
     * mark, as the content does not change.
     */
    refresh(copy: CopyRef): Promise<void>;
}

export interface NameSyncDeps {
    readonly store: Pick<
        PostgresNameStore,
        'due' | 'applied' | 'failed' | 'isOptedOut' | 'copies'
    >;
    readonly writer: Pick<FluxerNameWriter, 'rename'>;
    readonly ports: NameSyncPorts;
    readonly logger: AddonLogger;
    readonly now: () => Date;
}

export interface LinkRef {
    readonly id: string;
    readonly discordGuildId: string;
}

/** The newest copies with a webhook token, young enough for a live update. */
export function liveCopies(copies: readonly CopyRef[], now: Date): CopyRef[] {
    const since = now.getTime() - LIVE_UPDATE_AGE_MS;
    return copies
        .filter((c) => c.webhookId !== null && c.webhookToken !== null)
        .filter((c) => snowflakeTime(c.messageId).getTime() >= since)
        .sort((a, b) => (BigInt(b.messageId) > BigInt(a.messageId) ? 1 : -1))
        .slice(0, MAX_LIVE_UPDATES);
}

/** Puts each author's current Discord name on their Fluxer copies. */
export class NameSync {
    constructor(private readonly deps: NameSyncDeps) {}

    /** Handles the due authors of one link. Returns true when more are due. */
    async pass(link: LinkRef): Promise<boolean> {
        const due = await this.deps.store.due(
            link.discordGuildId,
            AUTHORS_PER_PASS + 1
        );
        for (const author of due.slice(0, AUTHORS_PER_PASS)) {
            await this.guarded(link, author);
        }
        return due.length > AUTHORS_PER_PASS;
    }

    private async guarded(link: LinkRef, author: DueAuthor): Promise<void> {
        try {
            await this.syncAuthor(link, author);
        } catch (error) {
            await this.deps.store.failed(
                link.discordGuildId,
                author.discordUserId
            );
            this.deps.logger.warn(
                `[name-sync] Author ${author.discordUserId} not renamed: ${describe(error)}`
            );
        }
    }

    private async syncAuthor(link: LinkRef, author: DueAuthor): Promise<void> {
        const { store, ports, writer, logger } = this.deps;
        const guildId = link.discordGuildId;
        const userId = author.discordUserId;
        // An opted-out author's copies are posted as "Member" on purpose.
        if (await store.isOptedOut(userId)) {
            await store.applied(guildId, userId, null, this.deps.now());
            return;
        }
        const names = await ports.names(guildId, userId);
        if (!names) throw new Error('Discord has no such user');
        const name = copyName(names);
        const copies = await store.copies(link.id, userId);
        const changed = await writer.rename(copies, name);
        if (changed > 0) await this.refreshRecent(copies);
        await store.applied(guildId, userId, name, this.deps.now());
        if (changed > 0) {
            logger.info(
                `[name-sync] ${changed} of ${copies.length} copies of ${userId} renamed`
            );
        }
    }

    /** A failed live update only delays the name until the app reloads. */
    private async refreshRecent(copies: readonly CopyRef[]): Promise<void> {
        for (const copy of liveCopies(copies, this.deps.now())) {
            try {
                await this.deps.ports.refresh(copy);
            } catch (error) {
                this.deps.logger.warn(
                    `[name-sync] Live update of ${copy.messageId} failed: ${describe(error)}`
                );
            }
        }
    }
}

export function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

import type { GuildSnapshot } from '../guild-sync/snapshot';
import type { ArchiveTarget, ChannelProgress } from './types';

/** Channel types with messages: text, voice (its chat), announcement. */
const MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 2, 5]);
/** A walked channel is checked for new messages this often. */
export const CATCH_UP_MS = 30 * 60_000;

export interface Target extends ArchiveTarget {
    /** The newest message Discord reported, when known (threads). */
    readonly lastMessageId: string | null;
}

/**
 * The channels and threads of a guild to archive, from guild-sync's
 * latest Discord snapshot. BF_ADDONS_EXCLUDE_CHANNELS is honoured: an
 * excluded category covers its channels, and a channel covers its threads.
 */
export function targetsFrom(
    snapshot: GuildSnapshot,
    excluded: ReadonlySet<string>
): Target[] {
    const parents = new Map(snapshot.channels.map((c) => [c.id, c.parentId]));
    const isExcluded = (id: string): boolean => {
        const parent = parents.get(id) ?? null;
        return excluded.has(id) || (parent !== null && excluded.has(parent));
    };
    const channels = snapshot.channels
        .filter((c) => MESSAGE_TYPES.has(c.type) && !isExcluded(c.id))
        .map(
            (c): Target => ({
                channelId: c.id,
                guildId: snapshot.guildId,
                kind: 'channel',
                parentId: c.parentId,
                lastMessageId: null,
            })
        );
    const threads = snapshot.threads
        .filter((t) => !isExcluded(t.parentId))
        .map(
            (t): Target => ({
                channelId: t.id,
                guildId: snapshot.guildId,
                kind: 'thread',
                parentId: t.parentId,
                lastMessageId: t.lastMessageId ?? null,
            })
        );
    return [...channels, ...threads];
}

const later = (a: string, b: string) => BigInt(a) > BigInt(b);

/**
 * The channels to walk now: unfinished walks first, then walked channels
 * due a check for new messages. A thread whose newest message is already
 * archived is skipped without asking Discord. Failed and forbidden
 * channels, and channels no longer in the snapshot, are left alone.
 */
export function dueChannels(
    progress: readonly ChannelProgress[],
    targets: readonly Target[],
    now: Date
): ChannelProgress[] {
    const byId = new Map(targets.map((t) => [t.channelId, t]));
    const walking = progress.filter(
        (p) => p.status === 'walking' && byId.has(p.channelId)
    );
    const catchUp = progress.filter((p) => {
        const target = byId.get(p.channelId);
        if (!target || p.status !== 'current') return false;
        const age = now.getTime() - (p.walkedAt?.getTime() ?? 0);
        if (age < CATCH_UP_MS) return false;
        const last = target.lastMessageId;
        return last === null || later(last, p.afterId);
    });
    return [...walking, ...catchUp];
}

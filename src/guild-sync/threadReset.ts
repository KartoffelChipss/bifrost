import { createHash } from 'node:crypto';
import type { MapRow } from './ops';
import type { GuildSnapshot } from './snapshot';
import type { CopiedThread, SyncSettings } from './store';

/**
 * `sync reset-threads`: deletes the Fluxer copies of Discord threads and
 * forgets them, so the next cycles create them again (oldest first) and
 * history import copies their messages again. Only thread rows created by
 * sync while Discord is the source qualify. Threads the mirror recorded
 * from Fluxer, channels, categories, roles and Discord are never touched.
 * This file holds the pure parts: what qualifies, the preview and the
 * confirmation code. threadResetJob.ts runs the reset.
 */

/** Upper bound on threads one reset deletes. The rest need another run. */
export const MAX_RESET_THREADS = 500;

/** How long a preview may be confirmed. */
export const RESET_PREVIEW_TTL_MS = 10 * 60_000;

/** Parent channels listed one by one in the preview; the rest are summed. */
export const MAX_PREVIEW_PARENTS = 25;

/** A thread copy one reset deletes, with its Discord parent if known. */
export interface ResetTarget extends CopiedThread {
    /** The Discord parent channel, from the last snapshot; null if unknown. */
    readonly parentId: string | null;
}

/** True for an active thread row created by sync with both IDs. */
function isCopiedThread(row: MapRow): boolean {
    return (
        row.kind === 'thread' &&
        row.state === 'active' &&
        row.createdBySync &&
        row.discordId !== null &&
        row.fluxerId !== null
    );
}

/** The link's thread rows: created by sync, and recorded from Fluxer. */
export interface ThreadRows {
    /** What a reset deletes, at most MAX_RESET_THREADS, by row ID. */
    readonly targets: readonly ResetTarget[];
    /** Rows created by sync, all of them, before the cap. */
    readonly copied: number;
    /** Active thread rows not created by sync. Never touched. */
    readonly recorded: number;
}

/**
 * The thread rows a reset deletes. Rows are sorted by ID, so the same map
 * gives the same targets, and the confirmation code matches them.
 */
export function resetTargets(
    rows: readonly MapRow[],
    discord: GuildSnapshot | null
): ThreadRows {
    const parents = new Map(
        (discord?.threads ?? []).map((t) => [t.id, t.parentId])
    );
    const copied = rows
        .filter(isCopiedThread)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const recorded = rows.filter(
        (row) =>
            row.kind === 'thread' &&
            row.state === 'active' &&
            !row.createdBySync
    ).length;
    const targets = copied.slice(0, MAX_RESET_THREADS).map((row) => ({
        rowId: row.id,
        discordId: row.discordId ?? '',
        fluxerId: row.fluxerId ?? '',
        parentId: parents.get(row.discordId ?? '') ?? null,
    }));
    return { targets, copied: copied.length, recorded };
}

/**
 * The targets whose map row is still the same active thread row created
 * by sync, read again once the reset holds the locks: a cycle may have
 * changed the map between the confirmation and the start.
 */
export function stillCopied<T extends CopiedThread>(
    rows: readonly MapRow[],
    targets: readonly T[]
): T[] {
    const current = new Map(
        rows.filter(isCopiedThread).map((row) => [row.id, row])
    );
    return targets.filter((t) => {
        const row = current.get(t.rowId);
        return row?.discordId === t.discordId && row.fluxerId === t.fluxerId;
    });
}

/**
 * Why a reset may not run, or null. It deletes Fluxer threads, so it
 * needs everything a cycle's writes need, and Discord as the source.
 */
export function resetBlocked(
    settings: SyncSettings,
    allowApply: boolean
): string | null {
    if (settings.killSwitch) {
        return 'The kill switch is on. A reset deletes Fluxer threads, so it runs only with the kill switch off.';
    }
    if (settings.mode !== 'apply') {
        return `The link is in ${settings.mode} mode. A reset runs only in apply mode.`;
    }
    if (!allowApply) {
        return 'A reset needs apply mode, and `BF_ADDONS_ALLOW_APPLY` is not true.';
    }
    if (settings.direction !== 'discord-to-fluxer') {
        return 'A reset only works while Discord is the source.';
    }
    return null;
}

/** Identifies one link and one exact set of targets. */
export function targetSetKey(
    guildLinkId: string,
    targets: readonly CopiedThread[]
): string {
    const hash = createHash('sha256').update(guildLinkId);
    for (const t of targets) {
        hash.update(`\n${t.rowId}:${t.discordId}:${t.fluxerId}`);
    }
    return hash.digest('hex');
}

/** Upper bound on remembered previews; past it, all are forgotten. */
const MAX_PENDING = 1_000;

interface Pending {
    readonly setKey: string;
    readonly expiresAt: number;
}

/** Whether a confirmation follows a fresh preview of the same set. */
export type PendingCheck = 'ok' | 'missing' | 'changed';

/**
 * Previews from `sync reset-threads`, one per user and link, held in
 * memory for RESET_PREVIEW_TTL_MS. A confirmation runs only the exact set
 * its own user previewed; a new preview replaces the old one.
 */
export class PendingResets {
    private readonly pending = new Map<string, Pending>();

    /** Remembers a preview of this set by this user on this link. */
    remember(
        guildLinkId: string,
        userId: string,
        setKey: string,
        now: Date
    ): void {
        if (this.pending.size >= MAX_PENDING) this.pending.clear();
        const expiresAt = now.getTime() + RESET_PREVIEW_TTL_MS;
        this.pending.set(slot(guildLinkId, userId), { setKey, expiresAt });
    }

    /** Checks a confirmation against the user's preview on this link. */
    check(
        guildLinkId: string,
        userId: string,
        setKey: string,
        now: Date
    ): PendingCheck {
        const found = this.pending.get(slot(guildLinkId, userId));
        if (!found || now.getTime() > found.expiresAt) return 'missing';
        return found.setKey === setKey ? 'ok' : 'changed';
    }

    /** Forgets the user's preview, once used. */
    clear(guildLinkId: string, userId: string): void {
        this.pending.delete(slot(guildLinkId, userId));
    }
}

function slot(guildLinkId: string, userId: string): string {
    return `${guildLinkId}\n${userId}`;
}

/** Targets per parent channel, the largest first, ties by ID. */
function perParent(targets: readonly ResetTarget[]): [string | null, number][] {
    const counts = new Map<string | null, number>();
    for (const t of targets) {
        counts.set(t.parentId, (counts.get(t.parentId) ?? 0) + 1);
    }
    return [...counts].sort(
        (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))
    );
}

/** One line per parent channel, bounded by MAX_PREVIEW_PARENTS. */
function parentLines(targets: readonly ResetTarget[]): string[] {
    const parents = perParent(targets);
    const lines = parents
        .slice(0, MAX_PREVIEW_PARENTS)
        .map(([id, n]) => `- ${id ? `<#${id}>` : 'parent unknown'}: ${n}`);
    const rest = parents.slice(MAX_PREVIEW_PARENTS);
    if (rest.length > 0) {
        const n = rest.reduce((sum, [, count]) => sum + count, 0);
        lines.push(`- ${rest.length} more channels: ${n}`);
    }
    return lines;
}

/** What `sync reset-threads` shows. Nothing changes until it is confirmed. */
export function describeResetPreview(
    rows: ThreadRows,
    blocked: string | null
): string {
    const { targets, copied, recorded } = rows;
    const lines = [
        '**Reset copied threads**: preview, nothing changed yet.',
        `Thread copies created by sync: **${copied}**. Threads recorded from Fluxer (${recorded}) are never touched.`,
    ];
    if (copied > targets.length) {
        lines.push(
            `This run resets **${targets.length}**; run it again for the other ${copied - targets.length}.`
        );
    }
    if (targets.length === 0) return lines.join('\n');
    lines.push('', 'By Discord parent channel:', ...parentLines(targets));
    lines.push(
        '',
        'Each Fluxer copy is deleted, about one per second, with its relayed message pairs, held replies and history progress. The next cycles create the threads again and history import copies their messages. Discord is not changed.'
    );
    if (blocked) {
        lines.push('', `Cannot run now: ${blocked}`);
        return lines.join('\n');
    }
    lines.push(
        '',
        `To go ahead within ${RESET_PREVIEW_TTL_MS / 60_000} minutes: \`sync reset-threads confirm\``
    );
    return lines.join('\n');
}

/**
 * Tells a real edit from other message updates. Both platforms send a
 * message update when a message is pinned or unpinned, or when a link
 * preview is added. Relaying such an update edits the copy, which then
 * shows "(edited)" although nobody edited anything.
 *
 * A real edit always sets a new edited time. So an update is an edit when
 * the message has an edited time and, with the old message cached, the
 * text or the edited time changed. Without the old message, only a recent
 * edited time counts: an update for a long-ago edit is a pin or preview.
 */

/** How recent the edited time must be when the old message is unknown. */
export const RECENT_EDIT_MS = 60_000;

/** The fields read from a discord.js or @fluxerjs/core message. */
export interface EditView {
    readonly partial?: boolean;
    readonly content?: string | null;
    /** discord.js */
    readonly editedTimestamp?: number | null;
    /** @fluxerjs/core */
    readonly editedAt?: Date | null;
}

function editedMs(message: EditView): number | null {
    if (typeof message.editedTimestamp === 'number') {
        return message.editedTimestamp;
    }
    return message.editedAt instanceof Date ? message.editedAt.getTime() : null;
}

/** True when `next` is a real edit of the message, not a pin or preview. */
export function isContentEdit(
    old: EditView | null | undefined,
    next: EditView,
    now: number
): boolean {
    const edited = editedMs(next);
    if (edited === null) return false;
    if (old && !old.partial) {
        return old.content !== next.content || editedMs(old) !== edited;
    }
    return now - edited <= RECENT_EDIT_MS;
}

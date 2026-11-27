import { createHash } from 'node:crypto';
import type { RelayPayload } from '../guild-sync/links';
import { MAX_CONTENT_LENGTH } from './limits';
import { capMentions } from './mentions';
import type { HistoryStore } from './store';
import type { HistoryPorts, Reaction, SourceMessage } from './types';

/** Reactions listed on one copy; the rest are left out. */
export const MAX_REACTIONS_SHOWN = 20;

const ZERO_WIDTH_SPACE = '​';

export function dateNote(when: Date): string {
    const stamp = when.toISOString().slice(0, 16).replace('T', ' ');
    return `*Originally posted ${stamp} UTC*`;
}

/** One line such as "Reactions: 👍 3 · 🎉 1", or null when there are none. */
export function reactionLine(reactions: readonly Reaction[]): string | null {
    if (reactions.length === 0) return null;
    const shown = reactions
        .slice(0, MAX_REACTIONS_SHOWN)
        .map((r) => `${r.name} ${r.count}`)
        .join(' · ');
    return `Reactions: ${shown}`;
}

/**
 * Upstream runs a Fluxer message that starts with the command prefix as a
 * command, and only the bridge's own webhook is exempt. A leading
 * zero-width space keeps an imported copy from running one.
 */
export function defuseCommand(content: string, prefix: string): string {
    return prefix !== '' && content.startsWith(prefix)
        ? `${ZERO_WIDTH_SPACE}${content}`
        : content;
}

const ELLIPSIS = '…';

/** Cuts `text` to at most `max` UTF-16 units without splitting a pair. */
export function cut(text: string, max: number): string {
    if (text.length <= max) return text;
    if (max <= 0) return '';
    const end = max;
    const code = text.charCodeAt(end - 1);
    const highSurrogate = code >= 0xd800 && code <= 0xdbff;
    return text.slice(0, highSurrogate ? end - 1 : end);
}

/**
 * Fits content within `max` characters, keeping its last line (the date
 * note or an edit marker) and shortening what comes before it.
 */
export function clipContent(content: string, max: number): string {
    if (content.length <= max) return content;
    const split = content.lastIndexOf('\n');
    const tail = split >= 0 ? content.slice(split) : '';
    if (tail.length + ELLIPSIS.length >= max) {
        return `${cut(content, max - ELLIPSIS.length)}${ELLIPSIS}`;
    }
    const head = cut(content, max - tail.length - ELLIPSIS.length);
    return `${head}${ELLIPSIS}${tail}`;
}

/**
 * A hash of a copy's text, to recognise it on Fluxer. Line endings and
 * surrounding whitespace are normalised, as a server may trim them.
 */
export function contentHash(content: string): string {
    const normal = content.replace(/\r\n/g, '\n').trim();
    return createHash('sha256').update(normal).digest('hex');
}

/**
 * Adds a note line just above the last line (the date note), fitted to
 * Fluxer's limit. A native copy has no date note, so the note goes last.
 */
export function withNote(
    content: string,
    note: string,
    native = false
): string {
    if (native) return clipContent(`${content}\n${note}`, MAX_CONTENT_LENGTH);
    const split = content.lastIndexOf('\n');
    const joined =
        split < 0
            ? `${content}\n${note}`
            : `${content.slice(0, split)}\n${note}${content.slice(split)}`;
    return clipContent(joined, MAX_CONTENT_LENGTH);
}

/**
 * Breaks @everyone and @here with a zero-width space, so they never ping
 * even where allowed_mentions is not sent.
 */
export function defuseMentions(content: string): string {
    return content.replace(/@(everyone|here)/g, `@${ZERO_WIDTH_SPACE}$1`);
}

/**
 * Shortens the message text so it, the lines below it and the leading
 * character defuseCommand may add stay within Fluxer's limit.
 */
export function fitBody(body: string, tail: readonly string[]): string {
    const below = tail.reduce((total, line) => total + line.length + 1, 0);
    const room = MAX_CONTENT_LENGTH - ZERO_WIDTH_SPACE.length - below;
    if (body.length <= room) return body;
    return `${cut(body, room - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** The copy of a message whose author opted out: no name, avatar or text. */
export function optOutPayload(): RelayPayload {
    return {
        content: '*A message from a member who opted out of history import.*',
        username: 'Member',
        avatarURL: '',
    };
}

/** The line a copy sent without its files carries above the date note. */
export function attachmentsNote(names: readonly string[]): string {
    return `*Attachments not copied: ${names.join(', ')}*`;
}

export interface FormatterDeps {
    readonly store: Pick<HistoryStore, 'isOptedOut'>;
    readonly ports: Pick<HistoryPorts, 'payload'>;
    readonly commandPrefix: string;
}

/**
 * How a copy was made. A native copy (the rewrite job,
 * src/history-rewrite) carries its Discord time in its ID and real
 * reactions, so it has no date or reactions line; a native reply is a
 * Fluxer reply, so it needs no quote.
 */
export interface CopyStyle {
    readonly native?: boolean;
    readonly nativeReply?: boolean;
}

/** Builds the Fluxer copy of a Discord message, for an import or an edit. */
export class CopyFormatter {
    constructor(private readonly deps: FormatterDeps) {}

    async build(
        message: SourceMessage,
        linkId: string,
        style: CopyStyle = {}
    ): Promise<RelayPayload> {
        const { store, ports } = this.deps;
        const base = (await store.isOptedOut(message.authorId))
            ? optOutPayload()
            : await ports.payload(message.raw, linkId, {
                  withoutReply:
                      style.nativeReply === true ||
                      (await this.hideReply(message)),
              });
        // An imported copy carries its original time, which Fluxer cannot
        // set; a native copy's ID already holds it.
        const tail = style.native
            ? []
            : [
                  reactionLine(message.reactions),
                  dateNote(message.createdAt),
              ].filter((line): line is string => Boolean(line));
        const lines = [fitBody(defuseMentions(base.content), tail), ...tail];
        return {
            ...base,
            content: defuseCommand(
                lines.filter(Boolean).join('\n'),
                this.deps.commandPrefix
            ),
        };
    }

    /**
     * The Discord users the copy of `message` mentions: none for an
     * opted-out author, whose copy carries no text.
     */
    async mentionsOf(message: SourceMessage): Promise<string[]> {
        const ids = message.mentionIds ?? [];
        if (ids.length === 0) return [];
        if (await this.deps.store.isOptedOut(message.authorId)) return [];
        return capMentions(ids);
    }

    /**
     * The reply quote repeats the quoted author's text, name and avatar, so
     * it is left out when that author opted out or cannot be told.
     */
    private async hideReply(message: SourceMessage): Promise<boolean> {
        if (!message.reply) return false;
        const authorId = message.reply.authorId;
        return (
            authorId === null || (await this.deps.store.isOptedOut(authorId))
        );
    }
}

import type { RelayPayload } from '../guild-sync/links';
import { MAX_CONTENT_LENGTH } from './limits';
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

function optOutBody(): RelayPayload {
    return {
        content: '*A message from a member who opted out of history import.*',
        username: 'Member',
        avatarURL: '',
    };
}

export interface FormatterDeps {
    readonly store: Pick<HistoryStore, 'isOptedOut'>;
    readonly ports: Pick<HistoryPorts, 'payload'>;
    readonly commandPrefix: string;
}

/** Builds the Fluxer copy of a Discord message, for an import or an edit. */
export class CopyFormatter {
    constructor(private readonly deps: FormatterDeps) {}

    async build(message: SourceMessage, linkId: string): Promise<RelayPayload> {
        const { store, ports } = this.deps;
        const base = (await store.isOptedOut(message.authorId))
            ? optOutBody()
            : await ports.payload(message.raw, linkId, {
                  withoutReply: await this.hideReply(message),
              });
        // The copy carries its original time, which Fluxer cannot set.
        const tail = [
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

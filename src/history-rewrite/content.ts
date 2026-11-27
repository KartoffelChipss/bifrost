import { dateNote } from '../history/format';

/** The quote embed bifrost puts first on a reply copy (DiscordMessageTransformer buildQuoteEmbed). */
const QUOTE_COLOR = 0x0b0d0e;
const REPLY_MARK = ' ↩️';
const ATTACHMENTS_NOTE = /^\*Attachments not copied: .*\*$/;
/** "Reactions: 👍 3 · :name: 1", as format.ts reactionLine writes it. */
const REACTIONS_LINE = /^Reactions: .+ \d+( · .+ \d+)*$/;
/** The date note is one of the last few lines: date, then an edit marker. */
const TAIL_LINES = 4;

/**
 * The text of a native copy: the copy's text without its date note and
 * its reactions line. Other notes (files not copied, an author's edit)
 * stay. Returns null when the date note is not where the importer puts
 * it, so the caller leaves that copy alone.
 */
export function nativeContent(content: string, createdAt: Date): string | null {
    const lines = content.split('\n');
    const note = dateNote(createdAt);
    const from = Math.max(0, lines.length - TAIL_LINES);
    let date = -1;
    for (let i = lines.length - 1; i >= from; i--) {
        if (lines[i] === note) {
            date = i;
            break;
        }
    }
    if (date < 0) return null;
    lines.splice(date, 1);
    let above = date - 1;
    if (above >= 0 && ATTACHMENTS_NOTE.test(lines[above] ?? '')) above--;
    if (above >= 0 && REACTIONS_LINE.test(lines[above] ?? '')) {
        lines.splice(above, 1);
    }
    return lines.join('\n');
}

interface StoredEmbed {
    readonly color?: unknown;
    readonly author?: { readonly name?: unknown } | null;
}

/** True for the reply quote bifrost adds as a copy's first embed. */
export function isReplyQuote(embed: unknown): boolean {
    if (typeof embed !== 'object' || embed === null) return false;
    const { color, author } = embed as StoredEmbed;
    const name = author?.name;
    return (
        color === QUOTE_COLOR &&
        typeof name === 'string' &&
        name.endsWith(REPLY_MARK)
    );
}

/** The copy's embeds without the reply quote, when it is first. */
export function withoutReplyQuote(embeds: readonly unknown[]): unknown[] {
    return embeds.length > 0 && isReplyQuote(embeds[0])
        ? embeds.slice(1)
        : [...embeds];
}

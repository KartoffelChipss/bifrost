/**
 * Which Discord users an imported copy mentions, so the copy can be
 * rendered again once one of them links accounts (fixup.ts).
 */

/**
 * Users recorded per message. A 2,000-character Discord message holds at
 * most about 90 user mentions; past this bound the rest are left out.
 */
export const MAX_MENTIONS_PER_MESSAGE = 50;

/** Mention tokens read from one message's text. */
const MAX_TOKENS = 200;

const USER_TOKEN = /<@!?(\d{1,25})>/g;
const SNOWFLAKE = /^\d{1,25}$/;

/**
 * The users a copy renders as mentions: those named by a `<@id>` token in
 * the text, which fidelity maps (relay-extras/fidelity/mentions.ts), and
 * the rest of Discord's `mentions` list. The replied-to user is in that
 * list when the reply pinged, but a history copy only quotes the reply,
 * with a plain name, so they count only when the text names them too.
 */
export function renderedMentions(
    content: string,
    mentioned: Iterable<string>,
    repliedUserId: string | null
): string[] {
    const ids = new Set<string>();
    let tokens = 0;
    for (const match of content.matchAll(USER_TOKEN)) {
        if (tokens >= MAX_TOKENS) break;
        tokens += 1;
        ids.add(match[1]);
    }
    const named = new Set(ids);
    for (const id of mentioned) {
        if (ids.size >= MAX_TOKENS) break;
        if (id === repliedUserId && !named.has(id)) continue;
        ids.add(id);
    }
    return capMentions([...ids]);
}

/** Distinct snowflakes, at most MAX_MENTIONS_PER_MESSAGE, in order. */
export function capMentions(ids: readonly string[]): string[] {
    const out = new Set<string>();
    for (const id of ids.slice(0, MAX_TOKENS)) {
        if (out.size >= MAX_MENTIONS_PER_MESSAGE) break;
        if (SNOWFLAKE.test(id)) out.add(id);
    }
    return [...out];
}

/** Compares two snowflakes as numbers. */
export function snowflakeAfter(a: string, b: string): boolean {
    return BigInt(a) > BigInt(b);
}

/**
 * How much mention work one history pass may do: Discord pages read by
 * the backfill, copies checked by fix-ups, and a time limit.
 */
export class WorkBudget {
    constructor(
        private pages: number,
        private copies: number,
        private readonly deadline: number,
        private readonly now: () => number
    ) {}

    /** True while time is left. */
    get open(): boolean {
        return this.now() < this.deadline;
    }

    /** Takes one page; false when none is left. */
    takePage(): boolean {
        if (!this.open || this.pages <= 0) return false;
        this.pages -= 1;
        return true;
    }

    /** Takes one copy; false when none is left. */
    takeCopy(): boolean {
        if (!this.open || this.copies <= 0) return false;
        this.copies -= 1;
        return true;
    }
}

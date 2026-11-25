import type { RelayPayload } from '../guild-sync/links';
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
        const lines = [
            base.content,
            reactionLine(message.reactions),
            dateNote(message.createdAt),
        ].filter((line): line is string => Boolean(line));
        return {
            ...base,
            content: defuseCommand(lines.join('\n'), this.deps.commandPrefix),
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

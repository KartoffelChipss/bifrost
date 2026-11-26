import type { AddonLogger } from '../addons/isolation';
import { FIDELITY_TTL_MS } from '../relay-extras/fidelity/cache';
import type { MentionBackfill } from './backfill';
import { describeError } from './errors';
import type { MentionFixups } from './fixup';
import type { HistoryMode } from './importer';
import type { MentionStore } from './mentionStore';
import { WorkBudget } from './mentions';

/**
 * Mention work in each history pass, after the import: the backfill first,
 * then fix-ups. It runs at low priority. While the import has work left,
 * a pass reads one Discord page and checks two copies; an idle import
 * leaves it the rest of a bounded budget.
 */

/**
 * A fix-up waits this long after a link: fidelity caches linked accounts
 * for FIDELITY_TTL_MS, and a copy rendered from a stale cache would not
 * change.
 */
export const FIXUP_DELAY_MS = FIDELITY_TTL_MS + 30_000;

export const BUSY_BUDGET = { pages: 1, copies: 2, ms: 10_000 } as const;
export const IDLE_BUDGET = { pages: 20, copies: 30, ms: 30_000 } as const;
/** Upper bound on guild links one pass works on. */
const MAX_LINKS = 50;

/** A guild link, as far as mention work needs it. */
interface LinkRef {
    readonly id: string;
}

export interface MentionWorkDeps {
    readonly mentions: Pick<MentionStore, 'ensureFixups'>;
    readonly backfill: Pick<MentionBackfill, 'run'>;
    readonly fixups: Pick<MentionFixups, 'run'>;
    readonly listGuildLinks: () => Promise<readonly LinkRef[]>;
    readonly mode: (linkId: string) => Promise<HistoryMode>;
    readonly now: () => number;
    readonly logger: AddonLogger;
}

/** A budget for one pass: small while the import is busy. */
export function budgetFor(busy: boolean, now: () => number): WorkBudget {
    const limits = busy ? BUSY_BUDGET : IDLE_BUDGET;
    return new WorkBudget(limits.pages, limits.copies, now() + limits.ms, now);
}

/**
 * Starts the fix-up of one member who just linked accounts, on every guild
 * link. Identity calls it after a link is saved (identity flow.ts
 * accountLinked).
 */
export function mentionLinkHook(deps: {
    readonly mentions: Pick<MentionStore, 'ensureFixups'>;
    readonly listGuildLinks: () => Promise<readonly LinkRef[]>;
    readonly now: () => Date;
}): (pair: { readonly discordUserId: string }) => Promise<void> {
    return async (pair) => {
        const links = await deps.listGuildLinks();
        const now = deps.now();
        await deps.mentions.ensureFixups(
            links.slice(0, MAX_LINKS).map((l) => l.id),
            pair.discordUserId,
            new Date(now.getTime() + FIXUP_DELAY_MS),
            now
        );
    };
}

export class MentionWork {
    private ensured = false;

    constructor(private readonly deps: MentionWorkDeps) {}

    /**
     * One pass of mention work. `busy` is true while the import has work
     * left. Returns true when mention work is left for a pass soon.
     */
    async run(busy: boolean, held: () => Promise<boolean>): Promise<boolean> {
        const links = (await this.deps.listGuildLinks()).slice(0, MAX_LINKS);
        await this.ensureOnce(links);
        const budget = budgetFor(busy, this.deps.now);
        let more = false;
        for (const link of links) {
            if (!budget.open || !(await held())) return more;
            more = (await this.runLink(link.id, budget, held)) || more;
        }
        return more;
    }

    /**
     * On the first pass after a start, starts a fix-up for every linked
     * member without one for their current link. One that did not finish
     * resumes where it stopped. Retried each pass until it succeeds.
     */
    private async ensureOnce(links: readonly LinkRef[]): Promise<void> {
        if (this.ensured) return;
        const { mentions, now, logger } = this.deps;
        try {
            const at = now();
            const started = await mentions.ensureFixups(
                links.map((l) => l.id),
                null,
                new Date(at + FIXUP_DELAY_MS),
                new Date(at)
            );
            this.ensured = true;
            if (started > 0)
                logger.info(`[history] Started ${started} mention fix-ups`);
        } catch (error) {
            logger.warn(
                `[history] Could not start mention fix-ups: ${describeError(error)}`
            );
        }
    }

    /**
     * Backfill, then fix-ups, for one link. Nothing runs in read-only. A
     * failure is logged and retried on a later pass: at the add-on
     * boundary it would switch every add-on to read-only.
     */
    private async runLink(
        linkId: string,
        budget: WorkBudget,
        held: () => Promise<boolean>
    ): Promise<boolean> {
        try {
            if ((await this.deps.mode(linkId)) === 'read-only') return false;
            const scanning = await this.deps.backfill.run(linkId, budget);
            const fixing = await this.deps.fixups.run(linkId, budget, held);
            return scanning || fixing;
        } catch (error) {
            this.deps.logger.warn(
                `[history] Mention work on guild link ${linkId}: ${describeError(error)}`
            );
            return false;
        }
    }
}

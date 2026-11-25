import type { AddonLogger } from '../addons/isolation';
import type { LinkedGuild } from '../guild-sync/cycle';
import { RollingLimit } from './limits';
import {
    BAN_REASON,
    MAX_BANS_PER_HOUR,
    ourBan,
    timeoutChange,
} from './moderation';
import { NickMemory } from './nick';
import type { IdentityPorts, MemberState } from './ports';
import type { AccountPair } from './store';

const HOUR_MS = 60 * 60_000;
/** Guild links whose ban budget is kept at once. */
const MAX_TRACKED_LINKS = 1_000;

/** What moderation needs of a link's plan. */
export interface ModerationPlan {
    readonly link: LinkedGuild;
    readonly mode: 'dry-run' | 'apply';
}

/** Moderation changes counted in one pass. */
export interface ModerationTally {
    bans: number;
    timeouts: number;
}

export type ModerationPorts = Pick<
    IdentityPorts,
    | 'discordBanned'
    | 'banFluxerMember'
    | 'fluxerBanReason'
    | 'unbanFluxerMember'
    | 'setFluxerTimeout'
>;

export interface ModerationDeps {
    readonly ports: ModerationPorts;
    readonly logger: AddonLogger;
    readonly now: () => number;
}

/**
 * Carries Discord bans and timeouts of linked members to their Fluxer
 * accounts. In dry-run it only counts them. Bans per link are capped per
 * rolling hour, so a mistake cannot ban everyone at once.
 */
export class MemberModeration {
    private readonly bans = new RollingLimit(
        MAX_BANS_PER_HOUR,
        HOUR_MS,
        MAX_TRACKED_LINKS
    );
    /** The timeout end this process last wrote, per link and member. */
    private readonly timeouts = new NickMemory();

    constructor(private readonly deps: ModerationDeps) {}

    /**
     * Bans the Fluxer account of a member banned on Discord. Returns true
     * when the member is banned there, so no other change is made.
     */
    async banIfBanned(
        plan: ModerationPlan,
        pair: AccountPair,
        tally: ModerationTally
    ): Promise<boolean> {
        const { ports, logger, now } = this.deps;
        const { link } = plan;
        if (
            !(await ports.discordBanned(
                link.discordGuildId,
                pair.discordUserId
            ))
        )
            return false;
        if (plan.mode !== 'apply') {
            tally.bans += 1;
            return true;
        }
        if (this.bans.take(link.id, 1, now()) === 0) {
            logger.warn(
                `[identity] Ban limit reached on guild link ${link.id}; a ban waits.`
            );
            return true;
        }
        await ports.banFluxerMember(
            link.fluxerGuildId,
            pair.fluxerUserId,
            BAN_REASON
        );
        tally.bans += 1;
        return true;
    }

    /** Copies a Discord timeout, or lifts one this process set. */
    async syncTimeout(
        plan: ModerationPlan,
        pair: AccountPair,
        discord: MemberState,
        fluxer: MemberState,
        tally: ModerationTally
    ): Promise<void> {
        const key = `${plan.link.id}:${pair.fluxerUserId}`;
        const change = timeoutChange(
            discord.timeoutUntil ?? null,
            fluxer.timeoutUntil ?? null,
            this.timeouts.get(key),
            this.deps.now()
        );
        if (!change) return;
        tally.timeouts += 1;
        if (plan.mode !== 'apply') return;
        await this.deps.ports.setFluxerTimeout(
            plan.link.fluxerGuildId,
            pair.fluxerUserId,
            change.until
        );
        this.timeouts.remember(key, change.until);
    }

    /** Lifts the Fluxer ban of an unbanned member, if this sync made it. */
    async unban(plan: ModerationPlan, pair: AccountPair): Promise<void> {
        if (plan.mode !== 'apply') return;
        const { ports } = this.deps;
        const guildId = plan.link.fluxerGuildId;
        const reason = await ports.fluxerBanReason(guildId, pair.fluxerUserId);
        if (ourBan(reason))
            await ports.unbanFluxerMember(guildId, pair.fluxerUserId);
    }
}

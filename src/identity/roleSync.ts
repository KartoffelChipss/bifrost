import type { AddonMode } from '../addons/config';
import type { AddonLogger } from '../addons/isolation';
import { resolveMode, type LinkedGuild } from '../guild-sync/cycle';
import type { GuildSyncStore } from '../guild-sync/store';
import { RollingLimit } from './limits';
import { NickMemory, nickChange, type NickChange } from './nick';
import type { IdentityPorts, MemberState } from './ports';
import {
    managedRoles,
    roleChanges,
    syncableRoles,
    type RoleChange,
} from './roles';
import type { AccountPair } from './store';

/**
 * Role removals per guild link per rolling hour, across sweeps and member
 * events. The rest wait, so an outage cannot strip everyone's roles.
 */
export const MAX_ROLE_REMOVALS_PER_HOUR = 25;
const HOUR_MS = 60 * 60_000;
/** Guild links one sweep or event visits. */
export const MAX_LINKS = 50;
/** Guild links whose removal budget is kept at once. */
const MAX_TRACKED_LINKS = 1_000;

export interface RoleSyncDeps {
    readonly store: Pick<
        GuildSyncStore,
        'loadSettings' | 'lastSnapshot' | 'loadObjectMap'
    >;
    readonly ports: Pick<
        IdentityPorts,
        | 'discordMember'
        | 'fluxerMember'
        | 'setFluxerMemberRoles'
        | 'setFluxerMemberNick'
    >;
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly processMode: () => AddonMode;
    readonly allowApply: boolean;
    readonly logger: AddonLogger;
    readonly now: () => number;
}

/** What one guild link needs for a member sync, loaded once per pass. */
export interface LinkPlan {
    readonly link: LinkedGuild;
    readonly mode: 'dry-run' | 'apply';
    readonly adminChannelId: string | null;
    /** Roles that may be added: mapped and not privileged. */
    readonly syncable: ReadonlyMap<string, string>;
    /** Roles that may be removed: every mapped member role. */
    readonly managed: ReadonlyMap<string, string>;
}

/** Changes counted in one pass. In dry-run they are only counted. */
export interface Tally {
    add: number;
    remove: number;
    nicks: number;
}

export const emptyTally = (): Tally => ({ add: 0, remove: 0, nicks: 0 });

const describePair = (pair: AccountPair) =>
    `Discord ${pair.discordUserId} / Fluxer ${pair.fluxerUserId}`;

/**
 * Keeps linked members' synced roles and nicknames in step. Every member
 * is synced on its own: one failure is logged and never stops the rest.
 */
export class RoleSync {
    private readonly removals = new RollingLimit(
        MAX_ROLE_REMOVALS_PER_HOUR,
        HOUR_MS,
        MAX_TRACKED_LINKS
    );
    private readonly nicks = new NickMemory();

    constructor(private readonly deps: RoleSyncDeps) {}

    /** Loads a link's settings, snapshot and map. Null when it syncs nothing. */
    async plan(link: LinkedGuild): Promise<LinkPlan | null> {
        const { store } = this.deps;
        const settings = await store.loadSettings(link.id);
        if (settings.direction !== 'discord-to-fluxer') return null;
        const { mode } = resolveMode(
            this.deps.processMode(),
            settings,
            this.deps.allowApply
        );
        if (mode === 'read-only') return null;
        const snapshot = await store.lastSnapshot(link.id, 'discord', true);
        if (!snapshot) return null;
        const rows = await store.loadObjectMap(link.id);
        return {
            link,
            mode,
            adminChannelId: settings.adminChannelId,
            syncable: syncableRoles(snapshot, rows),
            managed: managedRoles(snapshot, rows),
        };
    }

    /** Syncs one member on one link. Never throws. */
    async member(plan: LinkPlan, pair: AccountPair, tally: Tally) {
        try {
            await this.syncMember(plan, pair, tally);
        } catch (error) {
            this.deps.logger.warn(
                `[identity] Could not sync ${describePair(pair)} on guild link ${plan.link.id}:`,
                error
            );
        }
    }

    /** Syncs one member on every guild link that matches. Never throws. */
    async pair(
        pair: AccountPair,
        onLink: (link: LinkedGuild) => boolean = () => true
    ): Promise<void> {
        try {
            const links = (await this.deps.listGuildLinks()).filter(onLink);
            const tally = emptyTally();
            for (const link of links.slice(0, MAX_LINKS)) {
                const plan = await this.plan(link);
                if (plan) await this.member(plan, pair, tally);
            }
        } catch (error) {
            this.deps.logger.warn(
                `[identity] Could not sync ${describePair(pair)}:`,
                error
            );
        }
    }

    /**
     * Removes every synced role from a member whose accounts were just
     * unlinked, within the removal limit, in apply only. Never throws.
     */
    async strip(pair: AccountPair): Promise<void> {
        try {
            const links = await this.deps.listGuildLinks();
            for (const link of links.slice(0, MAX_LINKS)) {
                const plan = await this.plan(link);
                if (plan?.mode === 'apply') await this.stripOn(plan, pair);
            }
        } catch (error) {
            this.deps.logger.warn(
                `[identity] Could not remove synced roles of ${describePair(pair)}:`,
                error
            );
        }
    }

    private async stripOn(plan: LinkPlan, pair: AccountPair) {
        const fluxer = await this.deps.ports.fluxerMember(
            plan.link.fluxerGuildId,
            pair.fluxerUserId
        );
        if (!fluxer) return;
        const change = roleChanges(
            [],
            fluxer.roleIds,
            plan.syncable,
            plan.managed
        );
        await this.applyRoles(plan, pair, fluxer, change, emptyTally());
    }

    /** Syncs every pair on one link. Null when the link syncs nothing. */
    async sweepLink(
        link: LinkedGuild,
        pairs: readonly AccountPair[]
    ): Promise<{ plan: LinkPlan; tally: Tally } | null> {
        const plan = await this.plan(link);
        if (!plan) return null;
        const tally = emptyTally();
        for (const pair of pairs) await this.member(plan, pair, tally);
        return { plan, tally };
    }

    private async syncMember(plan: LinkPlan, pair: AccountPair, tally: Tally) {
        const { ports } = this.deps;
        const { link } = plan;
        // A member who left or was banned holds no roles there.
        const discord = (await ports.discordMember(
            link.discordGuildId,
            pair.discordUserId
        )) ?? { roleIds: [], nick: null };
        const fluxer = await ports.fluxerMember(
            link.fluxerGuildId,
            pair.fluxerUserId
        );
        if (!fluxer) return;
        const key = `${link.id}:${pair.fluxerUserId}`;
        const roles = roleChanges(
            discord.roleIds,
            fluxer.roleIds,
            plan.syncable,
            plan.managed
        );
        const nick = nickChange(discord.nick, fluxer.nick, this.nicks.get(key));
        if (plan.mode !== 'apply') {
            tally.add += roles.add.length;
            tally.remove += roles.remove.length;
            tally.nicks += nick ? 1 : 0;
            return;
        }
        await this.applyRoles(plan, pair, fluxer, roles, tally);
        if (nick) await this.applyNick(plan, pair, nick, tally);
    }

    private async applyRoles(
        plan: LinkPlan,
        pair: AccountPair,
        fluxer: MemberState,
        change: RoleChange,
        tally: Tally
    ) {
        const granted = this.removals.take(
            plan.link.id,
            change.remove.length,
            this.deps.now()
        );
        const removing = change.remove.slice(0, granted);
        if (granted < change.remove.length) {
            this.deps.logger.warn(
                `[identity] Role removal limit reached on guild link ${plan.link.id}; ${change.remove.length - granted} removals wait.`
            );
        }
        if (change.add.length === 0 && removing.length === 0) return;
        const next = fluxer.roleIds
            .filter((id) => !removing.includes(id))
            .concat(change.add);
        await this.deps.ports.setFluxerMemberRoles(
            plan.link.fluxerGuildId,
            pair.fluxerUserId,
            next
        );
        tally.add += change.add.length;
        tally.remove += removing.length;
    }

    private async applyNick(
        plan: LinkPlan,
        pair: AccountPair,
        change: NickChange,
        tally: Tally
    ) {
        await this.deps.ports.setFluxerMemberNick(
            plan.link.fluxerGuildId,
            pair.fluxerUserId,
            change.nick
        );
        this.nicks.remember(
            `${plan.link.id}:${pair.fluxerUserId}`,
            change.nick
        );
        tally.nicks += 1;
    }
}

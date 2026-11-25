import type { Sequelize } from 'sequelize';
import type { AddonLogger } from '../../addons/isolation';
import type { ChannelLinker } from '../../guild-sync/links';
import type { PostgresGuildSyncStore } from '../../guild-sync/store';
import { PostgresIdentityStore } from '../../identity/store';
import type { FindPair } from '../pairs';
import type { FidelityPorts, GuildLinkRef, Side } from './types';

export interface FidelityPortDeps {
    readonly sequelize: Sequelize;
    readonly store: Pick<PostgresGuildSyncStore, 'loadObjectMap'>;
    readonly listGuildLinks: () => Promise<readonly GuildLinkRef[]>;
    /** Upstream's channel links (upstreamBridge.ts). */
    readonly links: Pick<ChannelLinker, 'byDiscordChannel' | 'byFluxerChannel'>;
    readonly findPair: FindPair;
    readonly logger: AddonLogger;
}

/** Fidelity's lookups, on the stores and services the add-ons share. */
export function fidelityPorts(deps: FidelityPortDeps): FidelityPorts {
    // Read only: listPairs is the identity add-on's own query.
    const identity = new PostgresIdentityStore(deps.sequelize);
    const { links } = deps;
    return {
        listGuildLinks: deps.listGuildLinks,
        loadObjectMap: (id) => deps.store.loadObjectMap(id),
        listAccountPairs: () => identity.listPairs(),
        channelLink: (side: Side, id: string) =>
            side === 'discord'
                ? links.byDiscordChannel(id)
                : links.byFluxerChannel(id),
        findPair: deps.findPair,
        now: Date.now,
        logger: deps.logger,
    };
}

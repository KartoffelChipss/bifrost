import type { Client as FluxerClient } from '@fluxerjs/core';
import type { Sequelize } from 'sequelize';
import { isNotFound } from '../../guild-sync/apply';
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
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly logger: AddonLogger;
}

/** Whether a Fluxer message is still there; only Fluxer copies reply. */
async function fluxerMessageExists(
    ref: FidelityPortDeps['fluxerClientRef'],
    channelId: string,
    messageId: string
): Promise<boolean> {
    const client = ref.current;
    if (!client?.isReady()) throw new Error('Fluxer gateway is not ready');
    try {
        await client.channels.fetchMessage(channelId, messageId);
        return true;
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
    }
}

/** The sticker IDs of a Fluxer server; only Fluxer copies send stickers. */
async function fluxerStickerIds(
    ref: FidelityPortDeps['fluxerClientRef'],
    guildId: string
): Promise<ReadonlySet<string>> {
    const client = ref.current;
    if (!client?.isReady()) throw new Error('Fluxer gateway is not ready');
    const guild = await client.guilds.fetch(guildId);
    const stickers = await guild.fetchStickers();
    return new Set(stickers.map((sticker) => sticker.id));
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
        messageExists: async (side, channelId, messageId) =>
            side === 'fluxer' &&
            (await fluxerMessageExists(
                deps.fluxerClientRef,
                channelId,
                messageId
            )),
        guildStickerIds: async (side, guildId) =>
            side === 'fluxer'
                ? fluxerStickerIds(deps.fluxerClientRef, guildId)
                : new Set<string>(),
        now: Date.now,
        logger: deps.logger,
    };
}

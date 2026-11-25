import type { Client as FluxerClient } from '@fluxerjs/core';
import type { Client as DiscordClient } from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import { PostgresGuildSyncStore } from '../guild-sync/store';
import { followFluxerClient } from '../guild-sync/threadEvents';
import { EmojiTranslator } from './emojiMap';
import { listenToDiscord, listenToFluxer, type Wrap } from './events';
import { installFidelity } from './fidelity';
import { fidelityPorts } from './fidelity/ports';
import { FidelityService } from './fidelity/service';
import type { GuildLinkRef } from './fidelity/types';
import { PostgresHistoryPairs } from './historyPairs';
import { excludingChannels, pairFinder } from './pairs';
import { PinRelay } from './pinRelay';
import { ClientPlatform } from './platform';
import { ReactionRelay } from './reactionRelay';
import type { RelayLookupPorts, Side } from './types';
import type { ChannelLinker } from '../guild-sync/links';

/**
 * Live reactions and pins, started with the guild-sync add-on. They are
 * mirrored on every message pair the fork knows: channel relay copies,
 * thread relay copies and imported history copies (pairs.ts).
 *
 * Message fidelity (fidelity/) starts and stops with them: upstream's
 * transformers map mentions, emojis, pings, names, replies and stickers
 * while it is installed.
 *
 * Mode: like guild-sync's thread relay, this runs in dry-run and apply and
 * stops in read-only. Dry-run governs structure plans, not live relaying;
 * read-only (set by an admin, or tripped by a failed structure write)
 * stops every add-on write. Mode is read per event, so a trip takes
 * effect at once.
 *
 * Errors: listeners run through the boundary's live failure policy
 * (src/addons/isolation.ts). Repeated errors pause one feature, such as
 * pins, for a few minutes; they never switch the add-ons to read-only.
 */

export const RELAY_EXTRAS_NAME = 'relay-extras';

export interface RelayExtrasDeps {
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly sequelize: Sequelize;
    /** Upstream lookups (ReactionPorts section of upstreamBridge.ts). */
    readonly lookups: RelayLookupPorts;
    /** BF_ADDONS_EXCLUDE_CHANNELS: Discord channels and categories left out. */
    readonly excludedChannels?: ReadonlySet<string>;
    /** Upstream's guild links, for message fidelity. */
    readonly listGuildLinks: () => Promise<readonly GuildLinkRef[]>;
    /** Upstream's channel links, for message fidelity. */
    readonly links: Pick<ChannelLinker, 'byDiscordChannel' | 'byFluxerChannel'>;
}

export interface RelayExtras {
    start(context: AddonContext): Promise<void>;
    stop(): Promise<void>;
}

function buildRelays(deps: RelayExtrasDeps, context: AddonContext) {
    const store = new PostgresGuildSyncStore(deps.sequelize);
    const { lookups, discordClient, fluxerClientRef } = deps;
    const platform = new ClientPlatform(discordClient, fluxerClientRef);
    const history = new PostgresHistoryPairs(deps.sequelize);
    const anyPair = pairFinder({
        bridgedMessage: (side, id) => lookups.bridgedMessage(side, id),
        threadMessage: (side, id) => store.findThreadMessage(side, id),
        historyMessage: (side, id) => history.historyMessage(side, id),
    });
    const findPair = excludingChannels(
        anyPair,
        deps.excludedChannels ?? new Set(),
        (id) => platform.discordLineage(id)
    );
    const active = () => context.mode.mode !== 'read-only';
    const botId = (side: Side) =>
        (side === 'discord'
            ? discordClient.user?.id
            : fluxerClientRef.current?.user?.id) ?? null;
    const emojis = new EmojiTranslator({
        loadObjectMap: (id) => store.loadObjectMap(id),
        guildEmoji: (side, link, id) => lookups.guildEmoji(side, link, id),
        now: Date.now,
    });
    const { logger } = context;
    const fidelity = new FidelityService(
        fidelityPorts({
            sequelize: deps.sequelize,
            store,
            listGuildLinks: deps.listGuildLinks,
            links: deps.links,
            findPair: anyPair,
            logger,
        })
    );
    return {
        fidelity,
        reactions: new ReactionRelay({
            findPair,
            emojis,
            platform,
            botId,
            active,
            logger,
        }),
        pins: new PinRelay({
            findPair,
            platform,
            active,
            now: Date.now,
            logger,
        }),
    };
}

export function createRelayExtras(deps: RelayExtrasDeps): RelayExtras {
    let stopListening: (() => void) | null = null;
    return {
        async start(context) {
            const relays = buildRelays(deps, context);
            const wrap: Wrap = (task, fn) =>
                context.boundary.handler(RELAY_EXTRAS_NAME, task, fn);
            const stopDiscord = listenToDiscord(
                deps.discordClient,
                relays,
                wrap
            );
            const stopFluxer = followFluxerClient(
                deps.fluxerClientRef,
                (client) => listenToFluxer(client, relays, wrap)
            );
            installFidelity(relays.fidelity);
            stopListening = () => {
                installFidelity(null);
                stopDiscord();
                stopFluxer();
            };
        },
        async stop() {
            stopListening?.();
            stopListening = null;
        },
    };
}

/**
 * Runs the relay extras inside another add-on's lifecycle, so they start
 * and stop with guild-sync without a new add-on key.
 */
export function withRelayExtras(inner: Addon, extras: RelayExtras): Addon {
    return {
        name: inner.name,
        async start(context) {
            await inner.start(context);
            try {
                await extras.start(context);
            } catch (error) {
                // The host stops only add-ons that started; leave none half up.
                await inner.stop();
                throw error;
            }
        },
        async stop() {
            try {
                await extras.stop();
            } finally {
                await inner.stop();
            }
        },
    };
}

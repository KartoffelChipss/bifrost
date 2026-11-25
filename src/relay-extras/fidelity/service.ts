import { otherSide } from '../types';
import { FIDELITY_TTL_MS, TtlCache } from './cache';
import {
    accountIds,
    linkedChannel,
    objectIds,
    type Directed,
    type ObjectIds,
} from './maps';
import { channelIdsIn, MAX_CHANNEL_LOOKUPS } from './mentions';
import type {
    FidelityPorts,
    FidelityView,
    GuildLinkRef,
    SourceFacts,
    TargetMessageRef,
} from './types';
import { replyTarget } from './reply';
import { NO_STICKERS, swapStickers, type StickerSwap } from './stickers';
import { createView, NO_FIDELITY, type Resolution } from './view';

/** Upper bound on guild links and channels whose maps are cached. */
export const MAX_CACHED_LINKS = 100;
export const MAX_CACHED_CHANNELS = 2_000;
/** A failing lookup is reported at most this often. */
export const WARN_INTERVAL_MS = 60_000;

const ALL = 'all';

/**
 * Looks up the ID maps for one source message, so the transformer can
 * build a faithful copy. Any failure falls back to upstream's formatting:
 * a copy with flat mentions beats no copy.
 */
export class FidelityService {
    private readonly links: TtlCache<readonly GuildLinkRef[]>;
    private readonly objects: TtlCache<Directed<ObjectIds>>;
    private readonly accounts: TtlCache<Directed<ReadonlyMap<string, string>>>;
    private readonly channels: TtlCache<string | null>;
    private readonly targetStickers: TtlCache<ReadonlySet<string>>;
    private lastWarnAt = Number.NEGATIVE_INFINITY;

    constructor(private readonly ports: FidelityPorts) {
        const cache = <V>(size: number) =>
            new TtlCache<V>(FIDELITY_TTL_MS, size, ports.now);
        this.links = cache(1);
        this.objects = cache(MAX_CACHED_LINKS);
        this.accounts = cache(1);
        this.channels = cache(MAX_CACHED_CHANNELS);
        this.targetStickers = cache(MAX_CACHED_LINKS);
    }

    async prepare(facts: SourceFacts): Promise<FidelityView> {
        try {
            const resolution = await this.resolve(facts);
            return resolution ? createView(resolution) : NO_FIDELITY;
        } catch (error) {
            this.warn(error);
            return NO_FIDELITY;
        }
    }

    /** Reports a failure, at most once per WARN_INTERVAL_MS. */
    warn(error: unknown): void {
        const now = this.ports.now();
        if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
        this.lastWarnAt = now;
        const detail = error instanceof Error ? error.message : String(error);
        this.ports.logger.warn(
            `[relay-extras] fidelity lookup failed, relaying with plain formatting: ${detail}`
        );
    }

    private async resolve(facts: SourceFacts): Promise<Resolution | null> {
        const link = await this.guildLink(facts);
        if (!link) return null;
        const [objects, accounts] = await Promise.all([
            this.objects.get(link.id, async () =>
                objectIds(await this.ports.loadObjectMap(link.id))
            ),
            this.accounts.get(ALL, async () =>
                accountIds(await this.ports.listAccountPairs())
            ),
        ]);
        const ids = objects[facts.side];
        const channels = await this.channelMap(facts, link.id, ids);
        const replyTo = await this.replyTo(facts, link.id, channels);
        const stickers = await this.stickers(facts, link, ids.stickers);
        return {
            facts,
            target: otherSide(facts.side),
            mentions: {
                users: accounts[facts.side],
                roles: ids.roles,
                channels,
            },
            emojis: ids.emojis,
            replyTo,
            stickers,
        };
    }

    /** A failed sticker lookup keeps the images, not just the stickers. */
    private async stickers(
        facts: SourceFacts,
        link: GuildLinkRef,
        synced: ReadonlyMap<string, string>
    ): Promise<StickerSwap> {
        const target = otherSide(facts.side);
        if (target !== 'fluxer' || facts.stickers.length === 0) {
            return NO_STICKERS;
        }
        try {
            const onTarget = await this.targetStickers.get(
                link.fluxerGuildId,
                () => this.ports.guildStickerIds(target, link.fluxerGuildId)
            );
            return swapStickers(facts.stickers, synced, onTarget);
        } catch (error) {
            this.warn(error);
            return NO_STICKERS;
        }
    }

    /** A failed reply lookup costs the native reply, not the rest. */
    private async replyTo(
        facts: SourceFacts,
        guildLinkId: string,
        channels: ReadonlyMap<string, string>
    ): Promise<TargetMessageRef | null> {
        try {
            const channel = channels.get(facts.channelId);
            return await replyTarget(facts, guildLinkId, channel, this.ports);
        } catch (error) {
            this.warn(error);
            return null;
        }
    }

    private async guildLink(facts: SourceFacts): Promise<GuildLinkRef | null> {
        if (!facts.guildId) return null;
        const links = await this.links.get(ALL, () =>
            this.ports.listGuildLinks()
        );
        const key =
            facts.side === 'discord' ? 'discordGuildId' : 'fluxerGuildId';
        return links.find((link) => link[key] === facts.guildId) ?? null;
    }

    /**
     * Target IDs of the message's own channel and the channels it
     * mentions: guild-sync's object map first, then upstream's channel
     * links of the same guild link.
     */
    private async channelMap(
        facts: SourceFacts,
        guildLinkId: string,
        ids: ObjectIds
    ): Promise<ReadonlyMap<string, string>> {
        const wanted = new Set([
            facts.channelId,
            ...channelIdsIn(facts.content, MAX_CHANNEL_LOOKUPS),
        ]);
        const map = new Map<string, string>();
        for (const id of wanted) {
            const target =
                ids.channels.get(id) ??
                (await this.linkedChannel(facts, guildLinkId, id));
            if (target) map.set(id, target);
        }
        return map;
    }

    private linkedChannel(
        facts: SourceFacts,
        guildLinkId: string,
        channelId: string
    ): Promise<string | null> {
        return this.channels.get(`${facts.side}:${channelId}`, async () => {
            const link = await this.ports.channelLink(facts.side, channelId);
            if (!link || link.guildLinkId !== guildLinkId) return null;
            return linkedChannel(link, facts.side);
        });
    }
}

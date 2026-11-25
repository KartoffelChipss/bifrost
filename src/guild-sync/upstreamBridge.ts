import {
    Routes,
    type Client as FluxerClient,
    type Message as FluxerMessage,
} from '@fluxerjs/core';
import type { Client as DiscordClient } from 'discord.js';
import type { SnapshotSide } from '../addons/db/schema';
import type { ChannelLink } from '../db/entities/ChannelLink';
import type DiscordEntityResolver from '../services/entityResolver/DiscordEntityResolver';
import type FluxerEntityResolver from '../services/entityResolver/FluxerEntityResolver';
import type { LinkService } from '../services/LinkService';
import DiscordMessageTransformer from '../services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../services/messageTransformer/FluxerMessageTransformer';
import type { WebhookService } from '../services/WebhookService';
import type {
    ChannelLinker,
    LinkedChannel,
    RelayPayload,
    ThreadSource,
} from './links';
import type { ThreadRelayPorts } from './threadRelay';
import { discordThreadWebhook, fluxerThreadWebhook } from './threadWebhook';
import type { FluxerWebhookSend } from './writers/fluxer';

/**
 * Connects guild-sync to upstream Bifröst: its channel links, webhooks and
 * message formatting. This is the only guild-sync file that loads upstream
 * services, so the rest stays testable without Bifröst's environment.
 */

export interface UpstreamServices {
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly linkService: LinkService;
    readonly webhookService: WebhookService;
    readonly discordEntityResolver: DiscordEntityResolver;
    readonly fluxerEntityResolver: FluxerEntityResolver;
}

/** A Discord message, as upstream's transformer takes it. */
type DiscordMessage = Parameters<
    DiscordMessageTransformer['transformMessage']
>[0];

/** A first message older than this is marked with its original time. */
const BACKFILL_AGE_MS = 10 * 60_000;

function toLinked(link: ChannelLink): LinkedChannel {
    return {
        id: link.id,
        guildLinkId: link.guildLinkId,
        discordChannelId: link.discordChannelId,
        fluxerChannelId: link.fluxerChannelId,
        discordWebhook: {
            id: link.discordWebhookId,
            token: link.discordWebhookToken,
        },
        fluxerWebhook: {
            id: link.fluxerWebhookId,
            token: link.fluxerWebhookToken,
        },
    };
}

export class UpstreamBridge
    implements ChannelLinker, ThreadSource, ThreadRelayPorts
{
    private readonly fromDiscord = new DiscordMessageTransformer();
    private readonly fromFluxer = new FluxerMessageTransformer();

    constructor(private readonly up: UpstreamServices) {}

    /** For the Fluxer writer: upstream's webhook send, with its file handling. */
    readonly sendViaFluxerWebhook: FluxerWebhookSend = (webhook, payload) =>
        this.up.webhookService.sendMessageViaFluxerWebhook(webhook, payload);

    private fluxer(): FluxerClient {
        const client = this.up.fluxerClientRef.current;
        if (!client?.isReady()) throw new Error('Fluxer gateway is not ready');
        return client;
    }

    // ---- ChannelLinker

    async linkedDiscordChannels(discordGuildId: string): Promise<Set<string>> {
        const links =
            await this.up.linkService.getChannelLinksForDiscordGuild(
                discordGuildId
            );
        return new Set(links.map((link) => link.discordChannelId));
    }

    async byDiscordChannel(id: string): Promise<LinkedChannel | null> {
        const link =
            await this.up.linkService.getChannelLinkByDiscordChannelId(id);
        return link ? toLinked(link) : null;
    }

    async byFluxerChannel(id: string): Promise<LinkedChannel | null> {
        const link =
            await this.up.linkService.getChannelLinkByFluxerChannelId(id);
        return link ? toLinked(link) : null;
    }

    async link(
        guildLinkId: string,
        discordChannelId: string,
        fluxerChannelId: string
    ): Promise<void> {
        const { discordClient, webhookService, linkService } = this.up;
        // Upstream's helper takes text channels only. Forums and
        // announcement channels have webhooks too.
        const channel = await discordClient.channels.fetch(discordChannelId);
        if (!channel || !('createWebhook' in channel)) {
            throw new Error('this Discord channel cannot have a webhook');
        }
        const discordHook = await channel.createWebhook({
            name: `Fluxer Bridge Webhook for channel ${discordChannelId}`,
        });
        if (!discordHook.token)
            throw new Error('Discord gave no webhook token');
        const discordWebhook = { id: discordHook.id, token: discordHook.token };
        let fluxerWebhook: { id: string; token: string } | null = null;
        try {
            fluxerWebhook = await webhookService.createFluxerWebhook(
                fluxerChannelId,
                `Discord Bridge Webhook for channel ${fluxerChannelId}`
            );
            await linkService.createChannelLink({
                guildLinkId,
                discordChannelId,
                fluxerChannelId,
                discordWebhookId: discordWebhook.id,
                discordWebhookToken: discordWebhook.token,
                fluxerWebhookId: fluxerWebhook.id,
                fluxerWebhookToken: fluxerWebhook.token,
            });
        } catch (error) {
            // Leave no webhook behind for a link that was not saved.
            await this.dropWebhooks(discordWebhook, fluxerWebhook);
            throw error;
        }
    }

    private async dropWebhooks(
        discord: { id: string; token: string } | null,
        fluxer: { id: string; token: string } | null
    ): Promise<void> {
        const { webhookService } = this.up;
        if (discord) {
            await webhookService
                .deleteDiscordWebhook(discord.id, discord.token)
                .catch(() => undefined);
        }
        if (fluxer) {
            await webhookService
                .deleteFluxerWebhook(fluxer.id, fluxer.token)
                .catch(() => undefined);
        }
    }

    async unlink(discordChannelId: string): Promise<void> {
        const { linkService } = this.up;
        const link =
            await linkService.getChannelLinkByDiscordChannelId(
                discordChannelId
            );
        if (!link) return;
        const guildLink = await linkService.getGuildLinkById(link.guildLinkId);
        if (!guildLink) return;
        await linkService.removeChannelLinkForDiscord(
            guildLink.discordGuildId,
            link.linkId
        );
        const linked = toLinked(link);
        await this.dropWebhooks(linked.discordWebhook, linked.fluxerWebhook);
    }

    // ---- message formatting

    private async toFluxerPayload(
        message: DiscordMessage,
        guildLinkId: string
    ) {
        const { linkService, fluxerEntityResolver } = this.up;
        const guildLink = await linkService.getGuildLinkById(guildLinkId);
        const emojis = guildLink
            ? await fluxerEntityResolver.fetchEmojis(guildLink.fluxerGuildId)
            : [];
        return this.fromDiscord.transformMessage(message, emojis);
    }

    private async toDiscordPayload(
        message: FluxerMessage,
        guildLinkId: string
    ) {
        const { linkService, discordEntityResolver } = this.up;
        const guildLink = await linkService.getGuildLinkById(guildLinkId);
        const emojis = guildLink
            ? await discordEntityResolver.fetchEmojis(guildLink.discordGuildId)
            : [];
        return this.fromFluxer.transformMessage(message, emojis);
    }

    // ---- ThreadSource

    async starter(guildId: string, threadId: string): Promise<RelayPayload> {
        const { discordClient, linkService } = this.up;
        const thread = await discordClient.channels.fetch(threadId);
        if (!thread?.isThread()) throw new Error(`${threadId} is not a thread`);
        const message = await thread.fetchStarterMessage().catch(() => null);
        if (!message) {
            return {
                content:
                    '*The first message of this post is no longer available.*',
                username: discordClient.user?.username ?? 'Bifröst',
                avatarURL: discordClient.user?.avatarURL() ?? '',
            };
        }
        const guildLink =
            await linkService.getGuildLinkForDiscordGuild(guildId);
        const payload = await this.toFluxerPayload(
            message as DiscordMessage,
            guildLink?.id ?? ''
        );
        if (Date.now() - message.createdTimestamp < BACKFILL_AGE_MS)
            return payload;
        // Fluxer dates a message at the moment it is posted, so an older
        // post carries its original time in the text.
        const when = message.createdAt
            .toISOString()
            .slice(0, 16)
            .replace('T', ' ');
        const note = `*Originally posted ${when} UTC*`;
        return {
            ...payload,
            content: payload.content ? `${payload.content}\n${note}` : note,
        };
    }

    // ---- ThreadRelayPorts

    private async discordWebhook(link: LinkedChannel, threadId: string) {
        const client = await this.up.webhookService.getDiscordWebhook(
            link.discordWebhook.id,
            link.discordWebhook.token
        );
        if (!client) throw new Error('the Discord webhook is gone');
        return { client, scoped: discordThreadWebhook(client, threadId) };
    }

    private fluxerWebhook(link: LinkedChannel, threadId: string) {
        return fluxerThreadWebhook(this.fluxer(), link.fluxerWebhook, {
            threadId,
        });
    }

    async send(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        raw: unknown
    ): Promise<string> {
        const { webhookService } = this.up;
        if (to === 'fluxer') {
            const payload = await this.toFluxerPayload(
                raw as DiscordMessage,
                link.guildLinkId
            );
            const sent = await webhookService.sendMessageViaFluxerWebhook(
                this.fluxerWebhook(link, threadId),
                payload
            );
            return sent.messageId;
        }
        const payload = await this.toDiscordPayload(
            raw as FluxerMessage,
            link.guildLinkId
        );
        const { scoped } = await this.discordWebhook(link, threadId);
        const sent = await webhookService.sendMessageViaDiscordWebhook(
            scoped,
            payload
        );
        return sent.messageId;
    }

    async edit(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        messageId: string,
        raw: unknown
    ): Promise<void> {
        const { webhookService } = this.up;
        if (to === 'fluxer') {
            const payload = await this.toFluxerPayload(
                raw as DiscordMessage,
                link.guildLinkId
            );
            await webhookService.editMessageViaFluxerWebhook(
                this.fluxerWebhook(link, threadId),
                messageId,
                payload
            );
            return;
        }
        const payload = await this.toDiscordPayload(
            raw as FluxerMessage,
            link.guildLinkId
        );
        const { scoped } = await this.discordWebhook(link, threadId);
        await webhookService.editMessageViaDiscordWebhook(
            scoped,
            messageId,
            payload
        );
    }

    async remove(
        to: SnapshotSide,
        link: LinkedChannel,
        threadId: string,
        messageId: string
    ): Promise<void> {
        if (to === 'discord') {
            const { client } = await this.discordWebhook(link, threadId);
            await client.deleteMessage(messageId, threadId);
            return;
        }
        const { id, token } = link.fluxerWebhook;
        const route = `${Routes.webhookExecute(id, token)}/messages/${messageId}?thread_id=${encodeURIComponent(threadId)}`;
        await this.fluxer().rest.delete(route, { auth: false });
    }
}

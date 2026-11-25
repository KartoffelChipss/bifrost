import {
    ForumChannel as FluxerForumChannel,
    MediaChannel as FluxerMediaChannel,
    Routes,
    ThreadChannel as FluxerThreadChannel,
    type Client as FluxerClient,
    type Message as FluxerMessage,
} from '@fluxerjs/core';
import {
    ChannelType,
    DiscordAPIError,
    MessageType,
    RESTJSONErrorCodes,
    type Client as DiscordClient,
} from 'discord.js';
import type {
    FluxerCopy,
    HistoryPorts,
    PayloadOptions,
    SendTarget,
    SourceMessage,
} from '../history/types';
import { dateNote, defuseMentions, optOutPayload } from '../history/format';
import { copyWebhook, NO_MENTIONS } from '../history/quietWebhook';
import type { IdentityPorts, MemberState, UserInfo } from '../identity';
import type { Side } from '../identity/store';
import type { SnapshotSide } from '../addons/db/schema';
import type { ChannelLink } from '../db/entities/ChannelLink';
import type DiscordEntityResolver from '../services/entityResolver/DiscordEntityResolver';
import type FluxerEntityResolver from '../services/entityResolver/FluxerEntityResolver';
import type { LinkService } from '../services/LinkService';
import DiscordMessageTransformer from '../services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../services/messageTransformer/FluxerMessageTransformer';
import type { WebhookService } from '../services/WebhookService';
import {
    defuseContent,
    upstreamCommandPrefix,
} from '../relay-extras/commandPrefix';
import type {
    ChannelLinker,
    LinkedChannel,
    RelayPayload,
    ThreadSource,
} from './links';
import { isNotFound } from './apply';
import type { FluxerThreadInfo, ThreadMirrorPorts } from './threadMirror';
import type { ThreadRelayPorts } from './threadRelay';
import {
    discordPostWebhook,
    discordThreadWebhook,
    fluxerAllowedMentions,
    fluxerThreadWebhook,
} from './threadWebhook';
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
    /** Upstream's command prefix; read from the environment when unset. */
    readonly commandPrefix?: string;
}

/** A Discord message, as upstream's transformer takes it. */
type DiscordMessage = Parameters<
    DiscordMessageTransformer['transformMessage']
>[0];

/** Upstream names its Discord bridge webhooks with this prefix. */
const BRIDGE_HOOK_NAME = 'Fluxer Bridge Webhook for channel';

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
    implements
        ChannelLinker,
        ThreadSource,
        ThreadRelayPorts,
        ThreadMirrorPorts,
        HistoryPorts,
        IdentityPorts
{
    private readonly fromDiscord = new DiscordMessageTransformer();
    private readonly fromFluxer = new FluxerMessageTransformer();

    private readonly commandPrefix: string;

    constructor(private readonly up: UpstreamServices) {
        this.commandPrefix = up.commandPrefix ?? upstreamCommandPrefix();
    }

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
        const payload = await this.fromDiscord.transformMessage(
            message,
            emojis
        );
        // Every copy posted on Fluxer: a thread reply, an edit, a forum
        // starter or an imported message must not run as a command there.
        return {
            ...payload,
            content: defuseContent(payload.content, this.commandPrefix),
        };
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
        const { discordClient } = this.up;
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
        const payload = (await this.isOptedOut(message.author.id))
            ? optOutPayload()
            : await this.starterPayload(guildId, message as DiscordMessage);
        if (Date.now() - message.createdTimestamp < BACKFILL_AGE_MS)
            return payload;
        // Fluxer dates a message at the moment it is posted, so an older
        // post carries its original time in the text.
        const note = dateNote(message.createdAt);
        return {
            ...payload,
            content: payload.content ? `${payload.content}\n${note}` : note,
        };
    }

    /** A starter as the relay formats it, pinging no one. */
    private async starterPayload(
        guildId: string,
        message: DiscordMessage
    ): Promise<RelayPayload> {
        const guildLink =
            await this.up.linkService.getGuildLinkForDiscordGuild(guildId);
        const relayed = await this.toFluxerPayload(
            message,
            guildLink?.id ?? ''
        );
        return { ...relayed, content: defuseMentions(relayed.content) };
    }

    private optOuts: ((discordUserId: string) => Promise<boolean>) | null =
        null;

    /**
     * Sets history's opt-out check, so an opted-out member's first message
     * of an old forum post shows a placeholder. Null removes it.
     */
    useOptOuts(check: ((discordUserId: string) => Promise<boolean>) | null) {
        this.optOuts = check;
    }

    private async isOptedOut(discordUserId: string): Promise<boolean> {
        return this.optOuts ? this.optOuts(discordUserId) : false;
    }

    /**
     * The members of a private Discord thread. The bot joins it first:
     * Discord sends a private thread's messages only to its members, and
     * the thread relay needs them.
     */
    async members(_guildId: string, threadId: string): Promise<string[]> {
        const thread = await this.up.discordClient.channels.fetch(threadId);
        if (!thread?.isThread()) throw new Error(`${threadId} is not a thread`);
        if (!thread.joined && thread.joinable) await thread.join();
        const members = await thread.members.fetch();
        return [...members.keys()];
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

    /** `raw` is the Discord message copied: it decides who may be pinged. */
    private fluxerWebhook(link: LinkedChannel, threadId: string, raw: unknown) {
        return fluxerThreadWebhook(
            this.fluxer(),
            link.fluxerWebhook,
            { threadId },
            { allowed_mentions: fluxerAllowedMentions(raw) }
        );
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
                this.fluxerWebhook(link, threadId, raw),
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
                this.fluxerWebhook(link, threadId, raw),
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

    /** A thread message as `raw`, or null when it or its thread is gone. */
    async fetch(
        side: SnapshotSide,
        threadId: string,
        messageId: string
    ): Promise<unknown | null> {
        try {
            if (side === 'fluxer') {
                return await this.fluxer().channels.fetchMessage(
                    threadId,
                    messageId
                );
            }
            const thread = await this.up.discordClient.channels.fetch(threadId);
            if (!thread?.isThread()) return null;
            return await thread.messages.fetch({ message: messageId });
        } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
        }
    }

    // ---- ThreadMirrorPorts

    fluxerBotId(): string | null {
        return this.up.fluxerClientRef.current?.user?.id ?? null;
    }

    async fluxerThread(threadId: string): Promise<FluxerThreadInfo | null> {
        const client = this.fluxer();
        const thread = await client.channels.fetch(threadId);
        if (!(thread instanceof FluxerThreadChannel) || !thread.parentId) {
            return null;
        }
        const parent = await client.channels.fetch(thread.parentId);
        // Media channels hold posts like forums do.
        const forum =
            parent instanceof FluxerForumChannel ||
            parent instanceof FluxerMediaChannel;
        const tagNames = forum
            ? thread.appliedTags.flatMap((id) => {
                  const tag = parent.availableTags.find((t) => t.id === id);
                  return tag ? [tag.name] : [];
              })
            : [];
        return {
            id: thread.id,
            parentId: thread.parentId,
            name: thread.name ?? '',
            ownerId: thread.ownerId,
            forum,
            tags: tagNames.sort(),
            archived: thread.archived,
            locked: thread.locked,
        };
    }

    /** The Fluxer post's first message, or a placeholder when it is gone. */
    private async fluxerStarter(
        info: FluxerThreadInfo,
        guildLinkId: string
    ): Promise<RelayPayload> {
        const message = await this.fluxer()
            .channels.fetchMessage(info.id, info.id)
            .catch(() => null);
        if (message) return this.toDiscordPayload(message, guildLinkId);
        const me = this.up.discordClient.user;
        return {
            content: '*The first message of this post is no longer available.*',
            username: me?.username ?? 'Bifröst',
            avatarURL: me?.avatarURL() ?? '',
        };
    }

    async createDiscordPost(
        link: LinkedChannel,
        info: FluxerThreadInfo,
        starter: unknown | null
    ): Promise<string> {
        const forum = await this.up.discordClient.channels.fetch(
            link.discordChannelId
        );
        if (
            forum?.type !== ChannelType.GuildForum &&
            forum?.type !== ChannelType.GuildMedia
        ) {
            throw new Error(`${link.discordChannelId} is not a forum`);
        }
        const appliedTags = info.tags.flatMap((name) => {
            const tag = forum.availableTags.find((t) => t.name === name);
            return tag ? [tag.id] : [];
        });
        const payload = starter
            ? await this.toDiscordPayload(
                  starter as FluxerMessage,
                  link.guildLinkId
              )
            : await this.fluxerStarter(info, link.guildLinkId);
        const { client } = await this.discordWebhook(link, '');
        const post = discordPostWebhook(client, {
            threadName: info.name,
            appliedTags,
        });
        await this.up.webhookService.sendMessageViaDiscordWebhook(
            post.client,
            payload
        );
        const threadId = post.threadId();
        if (!threadId) throw new Error('Discord did not name the new post');
        return threadId;
    }

    async createDiscordThread(
        link: LinkedChannel,
        info: FluxerThreadInfo
    ): Promise<string> {
        const parent = await this.up.discordClient.channels.fetch(
            link.discordChannelId
        );
        if (
            parent?.type !== ChannelType.GuildText &&
            parent?.type !== ChannelType.GuildAnnouncement
        ) {
            throw new Error(`${link.discordChannelId} cannot hold threads`);
        }
        const thread = await parent.threads.create({ name: info.name });
        return thread.id;
    }

    // ---- HistoryPorts

    private async discordHistory(discordId: string) {
        const channel = await this.up.discordClient.channels.fetch(discordId);
        if (!channel?.isTextBased() || !('messages' in channel)) {
            throw new Error(`${discordId} has no message history`);
        }
        return channel;
    }

    /** What a person writes, including slash-command and app replies. */
    private readonly copyableTypes: ReadonlySet<MessageType> = new Set([
        MessageType.Default,
        MessageType.Reply,
        MessageType.ChatInputCommand,
        MessageType.ContextMenuCommand,
    ]);

    describe(raw: unknown): SourceMessage {
        const m = raw as DiscordMessage;
        return {
            id: m.id,
            authorId: m.author.id,
            createdAt: m.createdAt,
            copyable: this.copyableTypes.has(m.type),
            attachments: m.attachments.size,
            webhookId: m.webhookId ?? null,
            ownWebhook: this.fromOwnApp(m),
            // Discord sends the quoted message's author with a reply.
            reply:
                m.type === MessageType.Reply
                    ? { authorId: m.mentions.repliedUser?.id ?? null }
                    : null,
            reactions: m.reactions.cache.map((r) => ({
                name: r.emoji.id
                    ? `:${r.emoji.name ?? 'emoji'}:`
                    : (r.emoji.name ?? '?'),
                count: r.count,
            })),
            raw: m,
        };
    }

    /**
     * Discord sets `application_id` on a message from an application-owned
     * webhook; upstream's bridge webhooks are made by this bot.
     */
    private fromOwnApp(m: DiscordMessage): boolean {
        const { discordClient } = this.up;
        const own = discordClient.application?.id ?? discordClient.user?.id;
        return Boolean(m.webhookId && own && m.applicationId === own);
    }

    async bridgeWebhookIds(discordChannelId: string): Promise<Set<string>> {
        const { discordClient } = this.up;
        const channel = await discordClient.channels
            .fetch(discordChannelId)
            .catch(() => null);
        if (!channel || !('fetchWebhooks' in channel)) return new Set();
        const hooks = await channel.fetchWebhooks().catch(() => null);
        if (!hooks) return new Set();
        const me = discordClient.user?.id;
        return new Set(
            [...hooks.values()]
                .filter(
                    (h) =>
                        h.name.startsWith(BRIDGE_HOOK_NAME) ||
                        (me !== undefined && h.owner?.id === me)
                )
                .map((h) => h.id)
        );
    }

    async listMessages(
        discordId: string,
        afterId: string,
        limit: number
    ): Promise<SourceMessage[]> {
        const channel = await this.discordHistory(discordId);
        const page = await channel.messages.fetch({
            after: afterId,
            limit,
            cache: false,
        });
        return [...page.values()]
            .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
            .map((m) => this.describe(m));
    }

    async newestMessageId(discordId: string): Promise<string | null> {
        const channel = await this.discordHistory(discordId);
        const page = await channel.messages.fetch({ limit: 1, cache: false });
        return page.first()?.id ?? null;
    }

    payload(
        raw: unknown,
        guildLinkId: string,
        options: PayloadOptions = {}
    ): Promise<RelayPayload> {
        const message = raw as DiscordMessage;
        // The transformer quotes a reply only when the message has a
        // reference, so a view without one leaves the quote out.
        const source = options.withoutReply
            ? (Object.create(message, {
                  reference: { value: null },
              }) as DiscordMessage)
            : message;
        return this.toFluxerPayload(source, guildLinkId);
    }

    /** Discord returns at most 50 pins per page. */
    private static readonly PIN_PAGE = 50;
    private static readonly MAX_PIN_PAGES = 5;

    async pinnedMessageIds(discordId: string): Promise<string[]> {
        const channel = await this.discordHistory(discordId);
        const pins: { id: string; at: number }[] = [];
        let before: number | undefined;
        for (let page = 0; page < UpstreamBridge.MAX_PIN_PAGES; page++) {
            const result = await channel.messages.fetchPins({
                before,
                limit: UpstreamBridge.PIN_PAGE,
                cache: false,
            });
            for (const pin of result.items) {
                pins.push({ id: pin.message.id, at: pin.pinnedTimestamp });
            }
            if (!result.hasMore || result.items.length === 0) break;
            before = result.items[result.items.length - 1].pinnedTimestamp;
        }
        return pins.sort((a, b) => a.at - b.at).map((p) => p.id);
    }

    async pinCopy(fluxerChannelId: string, fluxerMessageId: string) {
        await this.fluxer().rest.put(
            Routes.channelPinMessage(fluxerChannelId, fluxerMessageId)
        );
    }

    async sendCopy(target: SendTarget, payload: RelayPayload): Promise<string> {
        const sent = await this.up.webhookService.sendMessageViaFluxerWebhook(
            copyWebhook(this.fluxer(), target),
            payload
        );
        return sent.messageId;
    }

    private copyRoute(target: SendTarget, messageId: string): string {
        const { id, token } = target.webhook;
        const thread = target.threadId
            ? `?thread_id=${encodeURIComponent(target.threadId)}`
            : '';
        return `${Routes.webhookExecute(id, token)}/messages/${messageId}${thread}`;
    }

    async editCopy(
        target: SendTarget,
        messageId: string,
        content: string
    ): Promise<void> {
        // Only the text changes, so the copy keeps its attachments.
        await this.fluxer().rest.patch(this.copyRoute(target, messageId), {
            body: { content, allowed_mentions: NO_MENTIONS },
            auth: false,
        });
    }

    async deleteCopy(target: SendTarget, messageId: string): Promise<void> {
        await this.fluxer().rest.delete(this.copyRoute(target, messageId), {
            auth: false,
        });
    }

    async recentFluxerMessages(
        fluxerId: string,
        limit: number
    ): Promise<FluxerCopy[]> {
        const channel = await this.fluxer().channels.fetch(fluxerId, {
            force: true,
        });
        const manager = (
            channel as {
                messages?: {
                    fetch(o: {
                        limit: number;
                    }): Promise<Map<string, FluxerMessage>>;
                };
            }
        ).messages;
        if (!manager) return [];
        const page = await manager.fetch({ limit });
        return [...page.values()]
            .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
            .map((m) => ({
                id: m.id,
                webhookId: m.webhookId ?? null,
                content: m.content ?? '',
            }));
    }

    async relayedLiveFluxer(fluxerMessageId: string): Promise<boolean> {
        const link =
            await this.up.linkService.getMessageLinkByFluxerMessageId(
                fluxerMessageId
            );
        return link !== null && link !== undefined;
    }

    createImportWebhook(fluxerChannelId: string) {
        return this.up.webhookService.createFluxerWebhook(
            fluxerChannelId,
            'Discord History Import'
        );
    }

    async threadState(discordThreadId: string) {
        const thread = await this.up.discordClient.channels.fetch(
            discordThreadId,
            { force: true }
        );
        if (!thread?.isThread()) {
            throw new Error(`${discordThreadId} is not a thread`);
        }
        return {
            archived: thread.archived ?? false,
            locked: thread.locked ?? false,
        };
    }

    async linkCreatedAt(discordChannelId: string): Promise<Date | null> {
        const link =
            await this.up.linkService.getChannelLinkByDiscordChannelId(
                discordChannelId
            );
        if (!link) return null;
        const at = new Date(link.createdAt);
        return Number.isNaN(at.getTime()) ? null : at;
    }

    async relayedLive(discordMessageId: string): Promise<boolean> {
        const link =
            await this.up.linkService.getMessageLinkByDiscordMessageId(
                discordMessageId
            );
        return link !== null && link !== undefined;
    }

    // ---- IdentityPorts

    async sendDm(side: Side, userId: string, text: string): Promise<void> {
        if (side === 'discord') {
            const user = await this.up.discordClient.users.fetch(userId);
            await user.send({ content: text, allowedMentions: { parse: [] } });
            return;
        }
        const user = await this.fluxer().users.fetch(userId);
        await user.send({ content: text });
    }

    async userInfo(side: Side, userId: string): Promise<UserInfo> {
        if (side === 'discord') {
            const user = await this.up.discordClient.users.fetch(userId);
            return {
                id: user.id,
                username: user.username,
                displayName: user.globalName,
            };
        }
        const user = await this.fluxer().users.fetch(userId);
        // Fluxer keeps legacy discriminators; all zeros means none.
        const tag = /^0*$/.test(user.discriminator)
            ? ''
            : `#${user.discriminator}`;
        return {
            id: user.id,
            username: `${user.username}${tag}`,
            displayName: user.globalName,
        };
    }

    async discordMember(
        guildId: string,
        userId: string
    ): Promise<MemberState | null> {
        const guild = await this.up.discordClient.guilds.fetch(guildId);
        try {
            const member = await guild.members.fetch({
                user: userId,
                force: true,
            });
            return {
                roleIds: [...member.roles.cache.keys()].filter(
                    (id) => id !== guildId
                ),
                nick: member.nickname,
                timeoutUntil:
                    member.communicationDisabledUntil?.toISOString() ?? null,
            };
        } catch (error) {
            const unknown =
                error instanceof DiscordAPIError &&
                (error.code === RESTJSONErrorCodes.UnknownMember ||
                    error.code === RESTJSONErrorCodes.UnknownUser);
            if (unknown) return null;
            throw error;
        }
    }

    async fluxerMember(
        guildId: string,
        userId: string
    ): Promise<MemberState | null> {
        const guild = await this.fluxer().guilds.fetch(guildId);
        try {
            const member = await guild.fetchMember(userId);
            return {
                roleIds: [...member.roles.roleIds],
                nick: member.nick,
                timeoutUntil:
                    member.communicationDisabledUntil?.toISOString() ?? null,
            };
        } catch (error) {
            if ((error as { statusCode?: unknown }).statusCode === 404) {
                return null;
            }
            throw error;
        }
    }

    async setFluxerMemberRoles(
        guildId: string,
        userId: string,
        roleIds: string[]
    ): Promise<void> {
        const guild = await this.fluxer().guilds.fetch(guildId);
        const member = await guild.fetchMember(userId);
        await member.roles.set(roleIds);
    }

    async setFluxerMemberNick(
        guildId: string,
        userId: string,
        nick: string | null
    ): Promise<void> {
        const guild = await this.fluxer().guilds.fetch(guildId);
        const member = await guild.fetchMember(userId);
        await member.edit({ nick });
    }

    async discordBanned(guildId: string, userId: string): Promise<boolean> {
        const guild = await this.up.discordClient.guilds.fetch(guildId);
        try {
            await guild.bans.fetch({ user: userId, force: true });
            return true;
        } catch (error) {
            const unknown =
                error instanceof DiscordAPIError &&
                error.code === RESTJSONErrorCodes.UnknownBan;
            if (unknown) return false;
            throw error;
        }
    }

    async banFluxerMember(
        guildId: string,
        userId: string,
        reason: string
    ): Promise<void> {
        const guild = await this.fluxer().guilds.fetch(guildId);
        await guild.ban(userId, { reason });
    }

    async fluxerBanReason(
        guildId: string,
        userId: string
    ): Promise<string | null> {
        const guild = await this.fluxer().guilds.fetch(guildId);
        const bans = await guild.fetchBans();
        const ban = bans.find((b) => b.user.id === userId);
        return ban ? (ban.reason ?? '') : null;
    }

    async unbanFluxerMember(guildId: string, userId: string): Promise<void> {
        const guild = await this.fluxer().guilds.fetch(guildId);
        await guild.unban(userId, 'Unbanned on Discord');
    }

    /** Fluxer takes the end as communication_disabled_until (ISO time). */
    async setFluxerTimeout(
        guildId: string,
        userId: string,
        until: string | null
    ): Promise<void> {
        const guild = await this.fluxer().guilds.fetch(guildId);
        const member = await guild.fetchMember(userId);
        await member.edit({
            communicationDisabledUntil: until,
            timeoutReason: until ? 'Timed out on Discord' : null,
        });
    }

    // ---- ReactionPorts (src/relay-extras: live reactions and pins)

    /** The message_links pair of a message relayed in a bridged channel. */
    async bridgedMessage(side: SnapshotSide, messageId: string) {
        const { linkService } = this.up;
        const link =
            side === 'discord'
                ? await linkService.getMessageLinkByDiscordMessageId(messageId)
                : await linkService.getMessageLinkByFluxerMessageId(messageId);
        if (!link) return null;
        const channel = await linkService.getChannelLinkById(
            link.channelLinkId
        );
        if (!channel) return null;
        return {
            guildLinkId: link.guildLinkId,
            discord: {
                channelId: channel.discordChannelId,
                messageId: link.discordMessageId,
            },
            fluxer: {
                channelId: channel.fluxerChannelId,
                messageId: link.fluxerMessageId,
            },
        };
    }

    /** A custom emoji of the guild link's server on `side`, if it is there. */
    async guildEmoji(side: SnapshotSide, guildLinkId: string, emojiId: string) {
        const { linkService, discordEntityResolver, fluxerEntityResolver } =
            this.up;
        const guildLink = await linkService.getGuildLinkById(guildLinkId);
        if (!guildLink) return null;
        // Both resolvers cache a guild's emoji list for a minute.
        const emojis: readonly {
            id: string;
            name: string | null;
            animated: boolean | null;
        }[] =
            side === 'discord'
                ? await discordEntityResolver.fetchEmojis(
                      guildLink.discordGuildId
                  )
                : await fluxerEntityResolver.fetchEmojis(
                      guildLink.fluxerGuildId
                  );
        const found = emojis.find((emoji) => emoji.id === emojiId);
        if (!found?.name) return null;
        return {
            id: found.id,
            name: found.name,
            animated: found.animated ?? false,
        };
    }
}

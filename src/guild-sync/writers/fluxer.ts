import {
    GuildChannel,
    Routes,
    ThreadChannel,
    ForumChannel,
    type Client,
    type Guild,
    type ThreadEditOptions,
    type Webhook,
} from '@fluxerjs/core';
import type { RelayPayload } from '../links';
import { fluxerThreadWebhook } from '../threadWebhook';
import {
    timedWrite,
    type ChannelMove,
    type ChannelPatch,
    type ChannelSpec,
    type EmojiChoice,
    type EmojiSpec,
    type GuildPatch,
    type GuildWriter,
    type OverwriteSpec,
    type PositionSpec,
    type RolePatch,
    type RoleSpec,
    type StickerPatch,
    type StickerSpec,
    type TagMetaSpec,
    type ThreadPatch,
    type ThreadSpec,
} from './writer';

function toOverwrites(overwrites: readonly OverwriteSpec[]) {
    return overwrites.map((o) => ({
        id: o.id,
        type: o.type,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
    }));
}

/** Thread defaults and forum settings, sent apart in the API's own names. */
const PARENT_FIELDS = [
    'defaultAutoArchive',
    'defaultThreadSlowmode',
    'defaultReaction',
    'sortOrder',
    'layout',
    'tagMeta',
] as const;

/** Channel fields for an edit, in the library's names. Tags go apart. */
function channelFields(patch: ChannelPatch) {
    const fields: Record<string, unknown> = { ...patch };
    delete fields.tags;
    delete fields.overwrites;
    for (const field of PARENT_FIELDS) delete fields[field];
    if (patch.overwrites !== undefined) {
        fields.permissionOverwrites = toOverwrites(patch.overwrites);
    }
    return fields as Parameters<GuildChannel['edit']>[0];
}

const emojiBody = (emoji: EmojiChoice | null) => ({
    emoji_id: emoji && 'id' in emoji ? emoji.id : null,
    emoji_name: emoji && 'name' in emoji ? emoji.name : null,
});

/**
 * The PATCH body for thread defaults and forum settings, with field names
 * from Fluxer's ChannelRequestSchemas and ForumRequestSchemas. The library
 * has no text-channel option for thread defaults.
 */
function parentBody(patch: ChannelPatch): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (patch.defaultAutoArchive !== undefined) {
        body.default_auto_archive_duration = patch.defaultAutoArchive;
    }
    if (patch.defaultThreadSlowmode !== undefined) {
        body.default_thread_rate_limit_per_user = patch.defaultThreadSlowmode;
    }
    if (patch.defaultReaction !== undefined) {
        body.default_reaction_emoji = patch.defaultReaction
            ? emojiBody(patch.defaultReaction)
            : null;
    }
    if (patch.sortOrder !== undefined)
        body.default_sort_order = patch.sortOrder;
    if (patch.layout !== undefined) body.default_forum_layout = patch.layout;
    return body;
}

/** Forum tags with their details. A known name keeps its tag ID. */
function tagList(
    names: readonly string[],
    meta: readonly TagMetaSpec[] | undefined,
    known: readonly { id: string; name: string }[]
) {
    return names.map((name) => {
        const id = known.find((t) => t.name === name)?.id;
        const detail = meta?.find((t) => t.name === name);
        return {
            ...(id ? { id } : {}),
            name,
            ...(detail
                ? {
                      moderated: detail.moderated,
                      emojiId:
                          detail.emoji && 'id' in detail.emoji
                              ? detail.emoji.id
                              : null,
                      emojiName:
                          detail.emoji && 'name' in detail.emoji
                              ? detail.emoji.name
                              : null,
                  }
                : {}),
        };
    });
}

const FORUM_TYPE = 15;
const PRIVATE_THREAD = 12;
/** The forum-post pinned flag (ThreadConstants.ts: PINNED = 1 << 1). */
const PINNED_FLAG = 1 << 1;
/** Bound on members added to one new private thread. */
const MAX_THREAD_MEMBERS = 100;

/** Sends a relay payload through a Fluxer webhook (upstream's helper). */
export type FluxerWebhookSend = (
    webhook: Webhook,
    payload: RelayPayload
) => Promise<{ messageId: string }>;

/** Tag IDs for tag names. A name the forum does not offer is left out. */
function tagIds(parent: GuildChannel, names: readonly string[]): string[] {
    if (!(parent instanceof ForumChannel)) return [];
    const ids: string[] = [];
    for (const name of names) {
        const tag = parent.availableTags.find((t) => t.name === name);
        if (tag) ids.push(tag.id);
    }
    return ids;
}

type CreateOptions = Parameters<Guild['createChannel']>[0];

const CATEGORY_TYPE = 4;

/** Create options with only the fields the channel kind has a value for. */
function createOptions(spec: ChannelSpec): CreateOptions {
    const options: CreateOptions = {
        name: spec.name,
        type: spec.type,
        permissionOverwrites: toOverwrites(spec.overwrites),
    };
    if (spec.parentId !== null) options.parentId = spec.parentId;
    if (spec.type === CATEGORY_TYPE) return options;
    if (spec.type === FORUM_TYPE) {
        options.availableTags = tagList(spec.tags, spec.tagMeta, []);
        if (spec.defaultReaction !== undefined) {
            options.defaultReactionEmoji = spec.defaultReaction
                ? {
                      emojiId: emojiBody(spec.defaultReaction).emoji_id,
                      emojiName: emojiBody(spec.defaultReaction).emoji_name,
                  }
                : null;
        }
        if (spec.sortOrder !== undefined) {
            options.defaultSortOrder = spec.sortOrder as never;
        }
        if (spec.layout !== undefined) {
            options.defaultForumLayout = spec.layout as never;
        }
    }
    if (spec.defaultAutoArchive !== undefined) {
        options.defaultAutoArchiveDuration = spec.defaultAutoArchive as never;
    }
    if (spec.defaultThreadSlowmode !== undefined) {
        options.defaultThreadRateLimitPerUser = spec.defaultThreadSlowmode;
    }
    options.nsfw = spec.nsfw;
    if (spec.topic !== null) options.topic = spec.topic;
    if (spec.rateLimitPerUser > 0) {
        options.rateLimitPerUser = spec.rateLimitPerUser;
    }
    if (spec.bitrate !== null) options.bitrate = spec.bitrate;
    if (spec.userLimit !== null) options.userLimit = spec.userLimit;
    return options;
}

/** Writes a Fluxer server's structure over REST. */
export class FluxerGuildWriter implements GuildWriter {
    /** Takes the client ref, because upstream replaces the client on restart. */
    constructor(
        private readonly clientRef: { readonly current: Client | null },
        /** Needed for forum posts, which start with a webhook message. */
        private readonly sendViaWebhook: FluxerWebhookSend | null = null,
        private readonly warn: (message: string) => void = () => undefined
    ) {}

    private async guild(guildId: string): Promise<Guild> {
        const client = this.clientRef.current;
        if (!client?.isReady()) throw new Error('Fluxer gateway is not ready');
        return timedWrite('Fluxer guild fetch', client.guilds.fetch(guildId));
    }

    async createRole(guildId: string, spec: RoleSpec): Promise<string> {
        const guild = await this.guild(guildId);
        // Fluxer's create call takes no hoist or mentionable value; the
        // apply step sends those as a follow-up once the role is owned.
        const role = await timedWrite(
            'Fluxer role create',
            guild.createRole({
                name: spec.name,
                color: spec.color,
                permissions: spec.permissions,
            })
        );
        return role.id;
    }

    async updateRole(
        guildId: string,
        roleId: string,
        patch: RolePatch
    ): Promise<void> {
        const guild = await this.guild(guildId);
        const { unicodeEmoji, icon, ...fields } = patch;
        if (Object.keys(fields).length > 0) {
            const role = await timedWrite(
                'Fluxer role fetch',
                guild.fetchRole(roleId)
            );
            await timedWrite('Fluxer role edit', role.edit(fields));
        }
        if (unicodeEmoji === undefined && icon === undefined) return;
        // The library treats the role icon as read-only; Fluxer's role
        // update takes `icon` and `unicode_emoji` (GuildRequestSchemas.ts).
        const body: Record<string, unknown> = {};
        if (unicodeEmoji !== undefined) body.unicode_emoji = unicodeEmoji;
        if (icon !== undefined) body.icon = icon;
        await timedWrite(
            'Fluxer role icon',
            guild.client.rest.patch(Routes.guildRole(guildId, roleId), {
                body,
            })
        );
    }

    async setRolePositions(
        guildId: string,
        positions: readonly PositionSpec[]
    ): Promise<void> {
        const guild = await this.guild(guildId);
        await timedWrite(
            'Fluxer role positions',
            guild.setRolePositions(positions.map((p) => ({ ...p })))
        );
    }

    async createChannel(guildId: string, spec: ChannelSpec): Promise<string> {
        const guild = await this.guild(guildId);
        const channel = await timedWrite(
            'Fluxer channel create',
            guild.createChannel(createOptions(spec))
        );
        return channel.id;
    }

    private async channel(guildId: string, channelId: string) {
        const guild = await this.guild(guildId);
        const channel = await timedWrite(
            'Fluxer channel fetch',
            guild.client.channels.fetch(channelId, { force: true })
        );
        if (!(channel instanceof GuildChannel)) {
            throw new Error(
                `Fluxer channel ${channelId} is not a guild channel`
            );
        }
        if (channel.guildId !== guild.id) {
            throw new Error(`Fluxer channel ${channelId} is in another guild`);
        }
        return channel;
    }

    async updateChannel(
        guildId: string,
        channelId: string,
        patch: ChannelPatch
    ): Promise<void> {
        const channel = await this.channel(guildId, channelId);
        if (Object.keys(channelFields(patch)).length > 0) {
            await timedWrite(
                'Fluxer channel edit',
                channel.edit(channelFields(patch))
            );
        }
        const body = parentBody(patch);
        if (Object.keys(body).length > 0) {
            await timedWrite(
                'Fluxer channel settings',
                channel.client.rest.patch(Routes.channel(channelId), { body })
            );
        }
        if ((patch.tags || patch.tagMeta) && channel instanceof ForumChannel) {
            // A known name keeps its tag ID, so posts keep their tags.
            const names =
                patch.tags ?? channel.availableTags.map((t) => t.name);
            await timedWrite(
                'Fluxer forum tags',
                channel.setAvailableTags(
                    tagList(names, patch.tagMeta, channel.availableTags)
                )
            );
        }
    }

    async setChannelPositions(
        guildId: string,
        moves: readonly ChannelMove[]
    ): Promise<void> {
        const guild = await this.guild(guildId);
        // The library's position helper cannot send preceding_sibling_id,
        // which Fluxer's ChannelPositionUpdateRequest accepts.
        const body = moves.map((m) => ({
            id: m.id,
            preceding_sibling_id: m.precedingId,
        }));
        await timedWrite(
            'Fluxer channel positions',
            guild.client.rest.patch(Routes.guildChannels(guildId), { body })
        );
    }

    async updateGuild(guildId: string, patch: GuildPatch): Promise<void> {
        const guild = await this.guild(guildId);
        const { defaultNotifications, ...rest } = patch;
        await timedWrite(
            'Fluxer guild edit',
            guild.edit({
                ...rest,
                ...(defaultNotifications === undefined
                    ? {}
                    : { defaultMessageNotifications: defaultNotifications }),
            } as Parameters<Guild['edit']>[0])
        );
    }

    async createEmoji(guildId: string, spec: EmojiSpec): Promise<string> {
        const guild = await this.guild(guildId);
        const emoji = await timedWrite(
            'Fluxer emoji create',
            guild.createEmoji({ name: spec.name, image: spec.image })
        );
        return emoji.id;
    }

    async renameEmoji(guildId: string, emojiId: string, name: string) {
        const guild = await this.guild(guildId);
        const emoji = await timedWrite(
            'Fluxer emoji fetch',
            guild.fetchEmoji(emojiId)
        );
        await timedWrite('Fluxer emoji edit', emoji.edit({ name }));
    }

    async createSticker(guildId: string, spec: StickerSpec): Promise<string> {
        const guild = await this.guild(guildId);
        const sticker = await timedWrite(
            'Fluxer sticker create',
            guild.createSticker({
                name: spec.name,
                image: spec.image,
                description: spec.description,
                tags: [...spec.tags],
            })
        );
        return sticker.id;
    }

    async updateSticker(
        guildId: string,
        stickerId: string,
        patch: StickerPatch
    ) {
        const guild = await this.guild(guildId);
        const sticker = await timedWrite(
            'Fluxer sticker fetch',
            guild.fetchSticker(stickerId)
        );
        await timedWrite('Fluxer sticker edit', sticker.edit({ ...patch }));
    }

    async deleteRole(guildId: string, roleId: string): Promise<void> {
        const guild = await this.guild(guildId);
        const role = await timedWrite(
            'Fluxer role fetch',
            guild.fetchRole(roleId)
        );
        await timedWrite('Fluxer role delete', role.delete());
    }

    async deleteChannel(guildId: string, channelId: string): Promise<void> {
        const channel = await this.channel(guildId, channelId);
        await timedWrite('Fluxer channel delete', channel.delete());
    }

    async deleteEmoji(guildId: string, emojiId: string): Promise<void> {
        const guild = await this.guild(guildId);
        const emoji = await timedWrite(
            'Fluxer emoji fetch',
            guild.fetchEmoji(emojiId)
        );
        await timedWrite('Fluxer emoji delete', emoji.delete());
    }

    async deleteSticker(guildId: string, stickerId: string): Promise<void> {
        const guild = await this.guild(guildId);
        const sticker = await timedWrite(
            'Fluxer sticker fetch',
            guild.fetchSticker(stickerId)
        );
        await timedWrite('Fluxer sticker delete', sticker.delete());
    }

    private async thread(guildId: string, threadId: string) {
        const guild = await this.guild(guildId);
        const thread = await timedWrite(
            'Fluxer thread fetch',
            guild.client.channels.fetch(threadId, { force: true })
        );
        if (!(thread instanceof ThreadChannel)) {
            throw new Error(`Fluxer channel ${threadId} is not a thread`);
        }
        return thread;
    }

    /** Starts a forum post with its first message, through the webhook. */
    private async createPost(parent: GuildChannel, spec: ThreadSpec) {
        if (!spec.starter || !spec.webhook || !this.sendViaWebhook) {
            throw new Error(
                'a forum post needs its first message and the channel webhook'
            );
        }
        const webhook = fluxerThreadWebhook(parent.client, spec.webhook, {
            threadName: spec.name,
            appliedTags: tagIds(parent, spec.tags),
        });
        const sent = await timedWrite(
            'Fluxer forum post',
            this.sendViaWebhook(webhook, spec.starter)
        );
        // Fluxer gives a post's first message the ID of the post itself
        // (MessageSendService.ts). No second call checks it: a failure
        // there would leave a post with no map row.
        return sent.messageId;
    }

    async createThread(guildId: string, spec: ThreadSpec): Promise<string> {
        const parent = await this.channel(guildId, spec.parentId);
        if (spec.parentType === FORUM_TYPE) {
            return this.createPost(parent, spec);
        }
        const manager = (
            parent as GuildChannel & {
                threads?: {
                    create(o: {
                        name: string;
                        type?: number;
                        invitable?: boolean;
                    }): Promise<ThreadChannel>;
                };
            }
        ).threads;
        if (!manager) throw new Error('this channel cannot hold threads');
        const thread = await timedWrite(
            'Fluxer thread create',
            manager.create(
                spec.private
                    ? {
                          name: spec.name,
                          type: PRIVATE_THREAD,
                          invitable: spec.invitable,
                      }
                    : { name: spec.name }
            )
        );
        await this.addMembers(thread, spec.members ?? []);
        return thread.id;
    }

    /**
     * Adds linked members to a new private thread. A refused member is
     * logged and skipped: failing here would leave the thread unowned.
     */
    private async addMembers(thread: ThreadChannel, ids: readonly string[]) {
        for (const id of ids.slice(0, MAX_THREAD_MEMBERS)) {
            try {
                await timedWrite(
                    'Fluxer thread member',
                    thread.members.add(id)
                );
            } catch (error) {
                const detail = error instanceof Error ? error.message : error;
                this.warn(
                    `[guild-sync] Could not add ${id} to private thread ${thread.id}: ${detail}`
                );
            }
        }
    }

    async updateThread(
        guildId: string,
        threadId: string,
        patch: ThreadPatch
    ): Promise<void> {
        const thread = await this.thread(guildId, threadId);
        const { tags, pinned, ...fields } = patch;
        const edit: ThreadEditOptions = { ...fields };
        if (pinned !== undefined) {
            edit.flags = pinned
                ? thread.flags | PINNED_FLAG
                : thread.flags & ~PINNED_FLAG;
        }
        if (tags && thread.parentId) {
            const parent = await this.channel(guildId, thread.parentId);
            Object.assign(edit, { appliedTags: tagIds(parent, tags) });
        }
        await timedWrite('Fluxer thread edit', thread.edit(edit));
    }

    async deleteThread(guildId: string, threadId: string): Promise<void> {
        const thread = await this.thread(guildId, threadId);
        await timedWrite('Fluxer thread delete', thread.delete());
    }
}

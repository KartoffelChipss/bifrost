import {
    GuildChannel,
    ThreadChannel,
    ForumChannel,
    type Client,
    type Guild,
    type Webhook,
} from '@fluxerjs/core';
import type { RelayPayload } from '../links';
import { fluxerThreadWebhook } from '../threadWebhook';
import {
    timedWrite,
    type ChannelPatch,
    type ChannelSpec,
    type EmojiSpec,
    type GuildWriter,
    type OverwriteSpec,
    type PositionSpec,
    type RolePatch,
    type RoleSpec,
    type StickerPatch,
    type StickerSpec,
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

/** Channel fields for an edit, in the library's names. Tags go apart. */
function channelFields(patch: ChannelPatch) {
    const fields: Record<string, unknown> = { ...patch };
    delete fields.tags;
    delete fields.overwrites;
    if (patch.overwrites !== undefined) {
        fields.permissionOverwrites = toOverwrites(patch.overwrites);
    }
    return fields as Parameters<GuildChannel['edit']>[0];
}

const FORUM_TYPE = 15;

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
        options.availableTags = spec.tags.map((name) => ({ name }));
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
        private readonly sendViaWebhook: FluxerWebhookSend | null = null
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
        const role = await timedWrite(
            'Fluxer role fetch',
            guild.fetchRole(roleId)
        );
        await timedWrite('Fluxer role edit', role.edit(patch));
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
        if (patch.tags && channel instanceof ForumChannel) {
            // A known name keeps its tag ID, so posts keep their tags.
            const tags = patch.tags.map((name) => {
                const known = channel.availableTags.find(
                    (t) => t.name === name
                );
                return known ? { id: known.id, name } : { name };
            });
            await timedWrite(
                'Fluxer forum tags',
                channel.setAvailableTags(tags)
            );
        }
    }

    async setChannelPositions(
        guildId: string,
        positions: readonly PositionSpec[]
    ): Promise<void> {
        const guild = await this.guild(guildId);
        await timedWrite(
            'Fluxer channel positions',
            guild.setChannelPositions(positions.map((p) => ({ ...p })))
        );
    }

    async renameGuild(guildId: string, name: string): Promise<void> {
        const guild = await this.guild(guildId);
        await timedWrite('Fluxer guild edit', guild.edit({ name }));
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
                    create(o: { name: string }): Promise<ThreadChannel>;
                };
            }
        ).threads;
        if (!manager) throw new Error('this channel cannot hold threads');
        const thread = await timedWrite(
            'Fluxer thread create',
            manager.create({ name: spec.name })
        );
        return thread.id;
    }

    async updateThread(
        guildId: string,
        threadId: string,
        patch: ThreadPatch
    ): Promise<void> {
        const thread = await this.thread(guildId, threadId);
        const { tags, ...fields } = patch;
        const edit: Parameters<ThreadChannel['edit']>[0] = { ...fields };
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

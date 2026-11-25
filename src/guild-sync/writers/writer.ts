import { withTimeout } from '../../addons/host';
import type { RelayPayload, WebhookRef } from '../links';

/**
 * Destination writes, in destination terms: IDs are destination IDs and
 * bitfields are decimal strings already translated and merged. A writer
 * holds no sync logic. Every method rejects on failure.
 */

export interface RoleSpec {
    readonly name: string;
    readonly color: number;
    readonly hoist: boolean;
    readonly mentionable: boolean;
    readonly permissions: string;
}

export interface OverwriteSpec {
    readonly id: string;
    /** 0 = role, 1 = member. */
    readonly type: 0 | 1;
    readonly allow: string;
    readonly deny: string;
}

export interface ChannelSpec {
    /** Raw API channel type. It is the same number on both platforms. */
    readonly type: number;
    readonly name: string;
    readonly parentId: string | null;
    readonly topic: string | null;
    readonly nsfw: boolean;
    readonly rateLimitPerUser: number;
    readonly bitrate: number | null;
    readonly userLimit: number | null;
    /** The complete overwrite list. The platform replaces the old one. */
    readonly overwrites: readonly OverwriteSpec[];
    /** Names of the tags a forum offers, in order. */
    readonly tags: readonly string[];
}

export interface ThreadSpec {
    readonly parentId: string;
    /** Raw API type of the parent channel. A forum needs a first message. */
    readonly parentType: number;
    readonly name: string;
    /** Names of the forum tags to apply. */
    readonly tags: readonly string[];
    /** The first message and the parent's webhook, for a forum post. */
    readonly starter: RelayPayload | null;
    readonly webhook: WebhookRef | null;
}

export interface ThreadPatch {
    readonly name?: string;
    readonly archived?: boolean;
    readonly locked?: boolean;
    readonly tags?: readonly string[];
}

export type RolePatch = Partial<RoleSpec>;
export type ChannelPatch = Partial<Omit<ChannelSpec, 'type'>>;

export interface PositionSpec {
    readonly id: string;
    readonly position: number;
}

export interface EmojiSpec {
    readonly name: string;
    /** A base64 data URI. */
    readonly image: string;
}

export interface StickerSpec extends EmojiSpec {
    readonly description: string;
    readonly tags: readonly string[];
}

export interface StickerPatch {
    readonly name?: string;
    readonly description?: string;
}

export interface GuildWriter {
    /** Returns the new role's ID. */
    createRole(guildId: string, spec: RoleSpec): Promise<string>;
    updateRole(
        guildId: string,
        roleId: string,
        patch: RolePatch
    ): Promise<void>;
    setRolePositions(
        guildId: string,
        positions: readonly PositionSpec[]
    ): Promise<void>;
    /** Returns the new channel's ID. */
    createChannel(guildId: string, spec: ChannelSpec): Promise<string>;
    updateChannel(
        guildId: string,
        channelId: string,
        patch: ChannelPatch
    ): Promise<void>;
    setChannelPositions(
        guildId: string,
        positions: readonly PositionSpec[]
    ): Promise<void>;
    renameGuild(guildId: string, name: string): Promise<void>;
    /** Returns the new emoji's ID. */
    createEmoji(guildId: string, spec: EmojiSpec): Promise<string>;
    renameEmoji(guildId: string, emojiId: string, name: string): Promise<void>;
    /** Returns the new sticker's ID. */
    createSticker(guildId: string, spec: StickerSpec): Promise<string>;
    updateSticker(
        guildId: string,
        stickerId: string,
        patch: StickerPatch
    ): Promise<void>;
    deleteRole(guildId: string, roleId: string): Promise<void>;
    deleteChannel(guildId: string, channelId: string): Promise<void>;
    deleteEmoji(guildId: string, emojiId: string): Promise<void>;
    deleteSticker(guildId: string, stickerId: string): Promise<void>;
    /** Returns the new thread's ID. */
    createThread(guildId: string, spec: ThreadSpec): Promise<string>;
    updateThread(
        guildId: string,
        threadId: string,
        patch: ThreadPatch
    ): Promise<void>;
    deleteThread(guildId: string, threadId: string): Promise<void>;
}

/** Time limit for one destination write. */
export const WRITE_TIMEOUT_MS = 30_000;

/** Runs one write under the time limit. */
export function timedWrite<T>(label: string, write: Promise<T>): Promise<T> {
    return withTimeout(write, WRITE_TIMEOUT_MS, label);
}

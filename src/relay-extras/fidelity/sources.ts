import type { Message as FluxerMessage } from '@fluxerjs/core';
import {
    MessageFlags,
    MessageType,
    PermissionFlagsBits,
    type Message as DiscordMessage,
} from 'discord.js';
import { buildDiscordStickerUrl } from '../../utils/buildStickerUrl';
import type {
    SourceAuthor,
    SourceFacts,
    SourcePings,
    SourceReply,
    SourceSticker,
} from './types';

/**
 * Reads the facts fidelity needs from a platform message. Pure, so tests
 * pass plain objects shaped like the platform message.
 */

export type DiscordSource = Pick<
    DiscordMessage,
    | 'guildId'
    | 'channelId'
    | 'content'
    | 'mentions'
    | 'member'
    | 'author'
    | 'type'
    | 'flags'
    | 'reference'
    | 'stickers'
>;

export type FluxerSource = Pick<
    FluxerMessage,
    | 'guildId'
    | 'channelId'
    | 'content'
    | 'mentions'
    | 'mentionRoles'
    | 'mentionEveryone'
    | 'member'
    | 'author'
>;

/** Both platforms take at most 100 IDs of each kind; more never ping. */
const MAX_PINGED = 100;

/**
 * discord.js `mentions` mirrors the API's `mentions`, `mention_roles` and
 * `mention_everyone`. `everyone` is set only when the author may mention
 * everyone. The API documents `mention_roles` only as "roles specifically
 * mentioned in this message" (Message object), not as roles that pinged.
 */
function discordPings(message: DiscordSource): SourcePings {
    const { users, everyone } = message.mentions;
    return {
        users: [...users.keys()].slice(0, MAX_PINGED),
        roles: pingedRoles(message).slice(0, MAX_PINGED),
        everyone: everyone === true,
    };
}

/**
 * The mentioned roles that could ping: a role anyone may mention, or any
 * role when the author has Mention @everyone, @here, and All Roles in the
 * channel (Discord's role `mentionable` flag and MENTION_EVERYONE
 * permission). A mention of any other role is plain text on Discord, so
 * the copy must not ping it either.
 */
function pingedRoles(message: DiscordSource): string[] {
    const roles = [...message.mentions.roles.values()];
    if (roles.every((role) => role.mentionable)) {
        return roles.map((role) => role.id);
    }
    const anyRole = mayMentionAnyRole(message);
    return roles
        .filter((role) => anyRole || role.mentionable)
        .map((role) => role.id);
}

/** False when the author's channel permissions are unknown. */
function mayMentionAnyRole(message: DiscordSource): boolean {
    const member = message.member;
    if (!member) return false;
    try {
        return member
            .permissionsIn(message.channelId)
            .has(PermissionFlagsBits.MentionEveryone);
    } catch {
        // permissionsIn throws for a channel not in the cache.
        return false;
    }
}

/** Fluxer's `mentions`, `mentionRoles` and `mentionEveryone` (Message). */
function fluxerPings(message: FluxerSource): SourcePings {
    return {
        users: (message.mentions ?? []).map((u) => u.id).slice(0, MAX_PINGED),
        roles: [...(message.mentionRoles ?? [])].slice(0, MAX_PINGED),
        everyone: message.mentionEveryone === true,
    };
}

/**
 * discord.js GuildMember.displayName is the nickname, else the global
 * display name, else the username; avatarURL is the server avatar or
 * null. A webhook's message has no member.
 */
function discordAuthor(message: DiscordSource): SourceAuthor {
    const member = message.member;
    return {
        displayName: member?.displayName ?? message.author?.globalName ?? null,
        avatarUrl: member?.avatarURL() ?? null,
    };
}

/**
 * Fluxer GuildMember.displayName is `nick ?? globalName ?? username` and
 * avatarURL the server avatar or null (dist/index.js). Message.member is
 * the cached member, which MESSAGE_CREATE fills in.
 */
function fluxerAuthor(message: FluxerSource): SourceAuthor {
    const member = message.member;
    return {
        displayName: member?.displayName ?? message.author?.globalName ?? null,
        avatarUrl: member?.avatarURL() ?? null,
    };
}

/**
 * A Discord reply, not a forward. The API lists the replied-to author in
 * `mentions` only when the reply pinged them; discord.js sets
 * `repliedUser` from `referenced_message` either way (Message.js).
 */
function discordReply(message: DiscordSource): SourceReply | null {
    const messageId = message.reference?.messageId;
    if (!messageId || message.type !== MessageType.Reply) return null;
    if (message.flags?.has(MessageFlags.HasSnapshot)) return null;
    const replied = message.mentions.repliedUser;
    return {
        messageId,
        pinged: replied ? message.mentions.users.has(replied.id) : false,
    };
}

/** The URL matches DiscordMessageTransformer.buildAttachments. */
function discordStickers(message: DiscordSource): SourceSticker[] {
    return [...(message.stickers?.values() ?? [])].map((sticker) => ({
        id: sticker.id,
        url: buildDiscordStickerUrl(sticker.id, 160),
    }));
}

export function discordFacts(message: DiscordSource): SourceFacts {
    return {
        side: 'discord',
        guildId: message.guildId,
        channelId: message.channelId,
        content: message.content ?? '',
        pinged: discordPings(message),
        author: discordAuthor(message),
        reply: discordReply(message),
        stickers: discordStickers(message),
    };
}

export function fluxerFacts(message: FluxerSource): SourceFacts {
    return {
        side: 'fluxer',
        guildId: message.guildId,
        channelId: message.channelId,
        content: message.content ?? '',
        pinged: fluxerPings(message),
        author: fluxerAuthor(message),
        // Discord webhooks can neither reply nor send stickers
        // (RESTPostAPIWebhookWithTokenJSONBody): quote and image stay.
        reply: null,
        stickers: [],
    };
}

import type { Client as DiscordClient } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';

export interface AccountIdentity {
    username: string;
    avatarURL: string;
}

export async function discordIdentity(
    client: DiscordClient,
    guildId: string | undefined,
    userId: string
): Promise<AccountIdentity | null> {
    try {
        const user = await client.users.fetch(userId);
        const guild = guildId ? client.guilds.cache.get(guildId) : undefined;
        let nickname: string | null = null;
        if (guild) {
            try {
                const member = await guild.members.fetch(userId);
                nickname = member.nickname;
            } catch {
                // The account can be linked before joining the destination server.
            }
        }
        return {
            username: nickname || user.globalName || user.username,
            avatarURL: user.displayAvatarURL(),
        };
    } catch {
        return null;
    }
}

export async function fluxerIdentity(
    client: FluxerClient,
    guildId: string | undefined,
    userId: string
): Promise<AccountIdentity | null> {
    try {
        const user = await client.users.fetch(userId);
        const guild = guildId ? client.guilds.get(guildId) : undefined;
        let nickname: string | null = null;
        if (guild) {
            try {
                const member = await guild.fetchMember(userId);
                nickname = member.nick;
            } catch {
                // The account can be linked before joining the destination server.
            }
        }
        return {
            username: nickname || user.globalName || user.username,
            avatarURL: user.avatarURL() || '',
        };
    } catch {
        return null;
    }
}

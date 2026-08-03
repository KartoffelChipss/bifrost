import { PermissionsBitField } from 'discord.js';
import {
    DISCORD_APP_ID,
    DISCORD_CLIENT_SECRET,
    WEB_PUBLIC_URL,
} from '../../utils/env';
import type { StoredGuild, StoredIdentity } from '../session';

const API_BASE = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds';

export const REDIRECT_URI = `${WEB_PUBLIC_URL}/api/auth/discord/callback`;

export function buildAuthorizeUrl(state: string): string {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', DISCORD_APP_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    return url.toString();
}

interface DiscordTokenResponse {
    access_token: string;
}

interface DiscordUserResponse {
    id: string;
    username: string;
    avatar: string | null;
}

interface DiscordGuildResponse {
    id: string;
    name: string;
    icon: string | null;
    permissions: string;
}

async function exchangeCode(code: string): Promise<string> {
    const res = await fetch(`${API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: DISCORD_APP_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
        }),
    });
    if (!res.ok) {
        throw new Error(
            `Discord token exchange failed: HTTP ${res.status} — ${await res.text()}`
        );
    }
    const data = (await res.json()) as DiscordTokenResponse;
    return data.access_token;
}

export async function completeLogin(code: string): Promise<StoredIdentity> {
    const accessToken = await exchangeCode(code);
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    const [userRes, guildsRes] = await Promise.all([
        fetch(`${API_BASE}/users/@me`, { headers: authHeader }),
        fetch(`${API_BASE}/users/@me/guilds`, { headers: authHeader }),
    ]);

    if (!userRes.ok) {
        throw new Error(`Discord /users/@me failed: HTTP ${userRes.status}`);
    }
    if (!guildsRes.ok) {
        throw new Error(
            `Discord /users/@me/guilds failed: HTTP ${guildsRes.status}`
        );
    }

    const user = (await userRes.json()) as DiscordUserResponse;
    const guilds = (await guildsRes.json()) as DiscordGuildResponse[];

    const storedGuilds: StoredGuild[] = guilds.map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon
            ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`
            : null,
        permissions: g.permissions,
    }));

    return {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
            : null,
        guilds: storedGuilds,
    };
}

export function guildPermissions(guild: StoredGuild): PermissionsBitField {
    return new PermissionsBitField(BigInt(guild.permissions));
}

import { PermissionsBitField } from '@fluxerjs/util';
import {
    FLUXER_API_URL,
    FLUXER_APP_ID,
    FLUXER_BASE_URL,
    FLUXER_CLIENT_SECRET,
    WEB_PUBLIC_URL,
} from '../../utils/env';
import type { StoredGuild, StoredIdentity } from '../session';

// Account OAuth (authorize/token/@me) lives on the central Fluxer web app,
// separate from a bridged instance's own API base — mirrors how Discord's
// OAuth stays on discord.com regardless of which guild you're bridging.
const AUTHORIZE_BASE = (FLUXER_BASE_URL || 'https://web.fluxer.app').replace(
    /\/$/,
    ''
);
const API_BASE = (FLUXER_API_URL || 'https://web.fluxer.app/api').replace(
    /\/$/,
    ''
);
const SCOPES = 'identify guilds';

export const REDIRECT_URI = `${WEB_PUBLIC_URL}/api/auth/fluxer/callback`;

export function buildAuthorizeUrl(state: string): string {
    const url = new URL(`${AUTHORIZE_BASE}/oauth2/authorize`);
    url.searchParams.set('client_id', FLUXER_APP_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    return url.toString();
}

interface FluxerTokenResponse {
    access_token: string;
}

interface FluxerUserResponse {
    id: string;
    username: string;
    avatar: string | null;
}

interface FluxerGuildResponse {
    id: string;
    name: string;
    icon: string | null;
    permissions: string;
}

// Fluxer's API rejects OAuth requests without a recognized Origin header
// (HTTP 403 INVALID_API_ORIGIN) — send the same origin the authorize page
// lives on, as if the request came from Fluxer's own web client.
const ORIGIN_HEADER = { Origin: AUTHORIZE_BASE };

async function exchangeCode(code: string): Promise<string> {
    const res = await fetch(`${API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...ORIGIN_HEADER,
        },
        body: new URLSearchParams({
            client_id: FLUXER_APP_ID,
            client_secret: FLUXER_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
        }),
    });
    if (!res.ok) {
        throw new Error(
            `Fluxer token exchange failed: HTTP ${res.status} — ${await res.text()}`
        );
    }
    const data = (await res.json()) as FluxerTokenResponse;
    return data.access_token;
}

export async function completeLogin(code: string): Promise<StoredIdentity> {
    const accessToken = await exchangeCode(code);
    const authHeader = {
        Authorization: `Bearer ${accessToken}`,
        ...ORIGIN_HEADER,
    };

    const [userRes, guildsRes] = await Promise.all([
        fetch(`${API_BASE}/users/@me`, { headers: authHeader }),
        fetch(`${API_BASE}/users/@me/guilds`, { headers: authHeader }),
    ]);

    if (!userRes.ok) {
        throw new Error(`Fluxer /users/@me failed: HTTP ${userRes.status}`);
    }
    if (!guildsRes.ok) {
        throw new Error(
            `Fluxer /users/@me/guilds failed: HTTP ${guildsRes.status}`
        );
    }

    const user = (await userRes.json()) as FluxerUserResponse;
    const guilds = (await guildsRes.json()) as FluxerGuildResponse[];

    const storedGuilds: StoredGuild[] = guilds.map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon
            ? `https://fluxerusercontent.com/icons/${g.id}/${g.icon}.webp`
            : null,
        permissions: g.permissions,
    }));

    return {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatar
            ? `https://fluxerusercontent.com/avatars/${user.id}/${user.avatar}.webp`
            : null,
        guilds: storedGuilds,
    };
}

export function guildPermissions(guild: StoredGuild): PermissionsBitField {
    return new PermissionsBitField(BigInt(guild.permissions));
}

import { FLUXER_BASE_URL } from './env';

export const generateDiscordBotInviteLink = (
    clientId: string,
    permissions: string,
    guildId?: string
) => {
    let url = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&integration_type=0&scope=bot`;
    if (guildId) {
        url += `&guild_id=${guildId}&disable_guild_select=true`;
    }
    return url;
};

export const generateFluxerBotInviteLink = (
    clientId: string,
    permissions: string,
    guildId?: string
) => {
    const baseUrl = FLUXER_BASE_URL?.replace(/\/$/, '') || 'https://fluxer.app';
    let url = `${baseUrl}/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${permissions}`;
    if (guildId) {
        url += `&guild_id=${guildId}&disable_guild_select=true`;
    }
    return url;
};

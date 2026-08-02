export interface Identity {
    id: string;
    username: string;
    avatarUrl: string | null;
}

export interface MeResponse {
    discord: Identity | null;
    fluxer: Identity | null;
}

export interface GuildSummary {
    id: string;
    name: string;
    icon: string | null;
    botPresent: boolean;
}

export interface GuildPair {
    guildLinkId: string;
    discord: GuildSummary;
    fluxer: GuildSummary;
}

export interface GuildsResponse {
    linkedPairs: GuildPair[];
    unlinkedDiscordGuilds: GuildSummary[];
    unlinkedFluxerGuilds: GuildSummary[];
}

export interface ChannelSummary {
    id: string;
    name: string;
}

export interface ChannelLinkSummary {
    id: string;
    discordChannel: ChannelSummary;
    fluxerChannel: ChannelSummary;
}

export interface GuildChannelsResponse {
    linked: ChannelLinkSummary[];
    unlinkedDiscordChannels: ChannelSummary[];
    unlinkedFluxerChannels: ChannelSummary[];
}

export interface CreateGuildLinkBody {
    discordGuildId: string;
    fluxerGuildId: string;
}

export interface CreateChannelLinkBody {
    guildLinkId: string;
    discordChannelId: string;
    fluxerChannelId: string;
}

export interface InviteLinkResponse {
    url: string;
}

export interface ApiErrorResponse {
    error: string;
}

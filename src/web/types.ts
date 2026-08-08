export interface Identity {
    id: string;
    username: string;
    avatarUrl: string | null;
}

export interface MeResponse {
    discord: Identity | null;
    fluxer: Identity | null;
    isOwner: boolean;
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

export interface UnlinkedChannelSummary extends ChannelSummary {
    categoryId: string | null;
    categoryName: string | null;
    position: number;
    categoryPosition: number | null;
}

export interface ChannelLinkSummary {
    id: string;
    discordChannel: ChannelSummary;
    fluxerChannel: ChannelSummary;
}

export interface GuildChannelsResponse {
    linked: ChannelLinkSummary[];
    unlinkedDiscordChannels: UnlinkedChannelSummary[];
    unlinkedFluxerChannels: UnlinkedChannelSummary[];
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

export interface AutolinkProposal {
    discordChannel: ChannelSummary;
    fluxerChannel: ChannelSummary;
    score: number;
}

export interface AutolinkPreviewResponse {
    proposals: AutolinkProposal[];
    unmatchedDiscordCount: number;
    unmatchedFluxerCount: number;
}

export interface AutolinkResultItem {
    discordChannel: ChannelSummary;
    fluxerChannel: ChannelSummary;
    error?: string;
}

export interface AutolinkResponse {
    linkedCount: number;
    results: AutolinkResultItem[];
}

export interface ApiErrorResponse {
    error: string;
}

export interface AdminStatsResponse {
    discordGuildCount: number | null;
    fluxerGuildCount: number | null;
    discordUserCount: number | null;
    fluxerUserCount: number | null;
    discordPingMs: number | null;
    fluxerPingMs: number | null;
    channelLinksCount: number;
    messageLinksCount: number;
    uptimeSeconds: number;
    memoryUsageMB: number;
    gitCommit: string | null;
    repoUrl: string | null;
    discordHealthy: boolean;
    fluxerHealthy: boolean;
}

export interface AdminGuildLinkSummary {
    guildLinkId: string;
    createdAt: string;
    discord: GuildSummary;
    fluxer: GuildSummary;
}

export interface AdminGuildLinksResponse {
    guildLinks: AdminGuildLinkSummary[];
}

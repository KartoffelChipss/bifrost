import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
    AdminGuildLinksResponse,
    AdminStatsResponse,
    AutolinkPreviewResponse,
    AutolinkResponse,
    ChannelLinkSummary,
    CreateChannelLinkBody,
    CreateGuildLinkBody,
    GuildChannelsResponse,
    GuildsResponse,
    InviteLinkResponse,
    MeResponse,
} from '../../../src/web/types';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, {
        credentials: 'include',
        headers: init?.body
            ? { 'Content-Type': 'application/json' }
            : undefined,
        ...init,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Request failed: HTTP ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
}

export function useMe() {
    return useQuery({
        queryKey: ['me'],
        queryFn: () => apiFetch<MeResponse>('/auth/me'),
    });
}

export function useLogout() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
        onSuccess: () => queryClient.invalidateQueries(),
    });
}

export function useGuilds() {
    return useQuery({
        queryKey: ['guilds'],
        queryFn: () => apiFetch<GuildsResponse>('/guilds'),
    });
}

export function useGuildChannels(guildLinkId: string | undefined) {
    return useQuery({
        queryKey: ['guild-channels', guildLinkId],
        queryFn: () =>
            apiFetch<GuildChannelsResponse>(
                `/guild-links/${guildLinkId}/channels`
            ),
        enabled: !!guildLinkId,
    });
}

export function useCreateGuildLink() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateGuildLinkBody) =>
            apiFetch<{ guildLinkId: string }>('/guild-links', {
                method: 'POST',
                body: JSON.stringify(body),
            }),
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: ['guilds'] }),
    });
}

export function useDeleteGuildLink() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (guildLinkId: string) =>
            apiFetch<void>(`/guild-links/${guildLinkId}`, { method: 'DELETE' }),
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: ['guilds'] }),
    });
}

export function useCreateChannelLink() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateChannelLinkBody) =>
            apiFetch<ChannelLinkSummary>('/channel-links', {
                method: 'POST',
                body: JSON.stringify(body),
            }),
        onSuccess: (_data, variables) =>
            queryClient.invalidateQueries({
                queryKey: ['guild-channels', variables.guildLinkId],
            }),
    });
}

export function useDeleteChannelLink(guildLinkId: string | undefined) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (channelLinkId: string) =>
            apiFetch<void>(`/channel-links/${channelLinkId}`, {
                method: 'DELETE',
            }),
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: ['guild-channels', guildLinkId],
            }),
    });
}

export function useAutolinkPreview(
    guildLinkId: string | undefined,
    enabled: boolean
) {
    return useQuery({
        queryKey: ['guild-autolink', guildLinkId],
        queryFn: () =>
            apiFetch<AutolinkPreviewResponse>(
                `/guild-links/${guildLinkId}/autolink`
            ),
        enabled: !!guildLinkId && enabled,
    });
}

export function useRunAutolink(guildLinkId: string | undefined) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () =>
            apiFetch<AutolinkResponse>(`/guild-links/${guildLinkId}/autolink`, {
                method: 'POST',
            }),
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: ['guild-channels', guildLinkId],
            }),
    });
}

export function useAdminStats() {
    return useQuery({
        queryKey: ['admin-stats'],
        queryFn: () => apiFetch<AdminStatsResponse>('/admin/stats'),
        refetchInterval: 30_000,
    });
}

export function useAdminGuildLinks() {
    return useQuery({
        queryKey: ['admin-guild-links'],
        queryFn: () => apiFetch<AdminGuildLinksResponse>('/admin/guild-links'),
    });
}

export function useAdminDeleteGuildLink() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (guildLinkId: string) =>
            apiFetch<void>(`/admin/guild-links/${guildLinkId}`, {
                method: 'DELETE',
            }),
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: ['admin-guild-links'] }),
    });
}

export function useInviteLink() {
    return useMutation({
        mutationFn: ({
            platform,
            guildId,
        }: {
            platform: 'discord' | 'fluxer';
            guildId: string;
        }) =>
            apiFetch<InviteLinkResponse>(
                `/invite-link?platform=${platform}&guildId=${guildId}`
            ),
    });
}

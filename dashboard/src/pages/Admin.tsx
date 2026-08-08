import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminStats, useMe } from '@/api/client';
import { Layout } from '../components/Layout';
import { GitCommit } from 'lucide-react';
import { DiscordIcon } from '../icons/DiscordIcon';
import { FluxerIcon } from '../icons/FluxerIcon';

function formatUptime(totalSeconds: number): string {
    const units = [
        { label: 'd', value: 86400 },
        { label: 'h', value: 3600 },
        { label: 'm', value: 60 },
        { label: 's', value: 1 },
    ];
    const parts: string[] = [];
    let remaining = Math.floor(totalSeconds);
    for (const unit of units) {
        if (parts.length >= 2) break;
        const amount = Math.floor(remaining / unit.value);
        if (amount > 0) {
            parts.push(`${amount}${unit.label}`);
            remaining -= amount * unit.value;
        }
    }
    return parts.length ? parts.join(' ') : '0s';
}

function StatCard({
    label,
    value,
}: {
    label: string;
    value: string | number | null;
}) {
    return (
        <Card>
            <CardPanel className="flex flex-col gap-1 p-4">
                <span className="text-muted-foreground text-xs">{label}</span>
                <span className="text-xl font-semibold">
                    {value === null ? 'N/A' : value}
                </span>
            </CardPanel>
        </Card>
    );
}

function StatsSection() {
    const { data: stats, isLoading } = useAdminStats();

    if (isLoading || !stats) {
        return (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton key={i} className="h-18 rounded-2xl" />
                ))}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <Badge
                    variant={stats.discordHealthy ? 'success' : 'error'}
                    size={'lg'}
                >
                    <DiscordIcon />
                    Discord {stats.discordHealthy ? 'up' : 'down'}
                </Badge>
                <Badge
                    variant={stats.fluxerHealthy ? 'success' : 'error'}
                    size={'lg'}
                >
                    <FluxerIcon />
                    Fluxer {stats.fluxerHealthy ? 'up' : 'down'}
                </Badge>
                {stats.gitCommit && (
                    <Badge variant="outline" size="lg">
                        <GitCommit />
                        {stats.repoUrl ? (
                            <a
                                href={`${stats.repoUrl}/commit/${stats.gitCommit}`}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {stats.gitCommit.slice(0, 7)}
                            </a>
                        ) : (
                            stats.gitCommit.slice(0, 7)
                        )}
                    </Badge>
                )}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <StatCard
                    label="Discord guilds"
                    value={stats.discordGuildCount}
                />
                <StatCard
                    label="Fluxer guilds"
                    value={stats.fluxerGuildCount}
                />
                <StatCard
                    label="Discord users"
                    value={stats.discordUserCount}
                />
                <StatCard label="Fluxer users" value={stats.fluxerUserCount} />
                <StatCard
                    label="Channel links"
                    value={stats.channelLinksCount}
                />
                <StatCard
                    label="Message links"
                    value={stats.messageLinksCount}
                />
                <StatCard
                    label="Discord latency"
                    value={
                        stats.discordPingMs === null
                            ? null
                            : `${stats.discordPingMs}ms`
                    }
                />
                <StatCard
                    label="Fluxer latency"
                    value={
                        stats.fluxerPingMs === null
                            ? null
                            : `${stats.fluxerPingMs}ms`
                    }
                />
                <StatCard
                    label="Uptime"
                    value={formatUptime(stats.uptimeSeconds)}
                />
                <StatCard
                    label="Memory usage"
                    value={`${stats.memoryUsageMB} MB`}
                />
            </div>
        </div>
    );
}

function NotAuthorized() {
    return (
        <Card className="mx-auto mt-16 max-w-md">
            <CardHeader>
                <CardTitle>Not authorized</CardTitle>
            </CardHeader>
            <CardPanel>
                <p className="text-muted-foreground text-sm">
                    This page is only available to the bot owner.
                </p>
            </CardPanel>
        </Card>
    );
}

export function Admin() {
    const { data: me } = useMe();

    return (
        <Layout title="Admin" requiredAuth="either">
            {!me?.isOwner ? (
                <NotAuthorized />
            ) : (
                <div className="flex flex-col gap-4">
                    <h1 className="text-xl font-semibold">Admin dashboard</h1>
                    <StatsSection />
                </div>
            )}
        </Layout>
    );
}

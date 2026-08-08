import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, PackageOpen, Trash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { toastManager } from '@/components/ui/toast';
import { useDeleteChannelLink, useGuildChannels } from '@/api/client';
import { Layout } from '../components/Layout';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '../components/ui/empty';
import { CreateChannelLinkDialog } from '../components/CreateChannelLinkDialog';
import { AutolinkDialog } from '../components/AutolinkDialog';

export function GuildDetail() {
    const { guildLinkId } = useParams<{ guildLinkId: string }>();
    const { data, isLoading } = useGuildChannels(guildLinkId);
    const deleteChannelLink = useDeleteChannelLink(guildLinkId);

    const content = (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
                <Button render={<Link to="/" />} variant="ghost" size="sm">
                    <ArrowLeft aria-hidden="true" />
                    Back
                </Button>
                {data && (
                    <div className="flex gap-2">
                        <AutolinkDialog
                            guildLinkId={guildLinkId!}
                            disabled={
                                data.unlinkedDiscordChannels.length === 0 ||
                                data.unlinkedFluxerChannels.length === 0
                            }
                        />
                        <CreateChannelLinkDialog
                            guildLinkId={guildLinkId!}
                            discordChannels={data.unlinkedDiscordChannels}
                            fluxerChannels={data.unlinkedFluxerChannels}
                        />
                    </div>
                )}
            </div>

            {isLoading || !data ? (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Discord channel</TableHead>
                            <TableHead>Fluxer channel</TableHead>
                            <TableHead className="w-px" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {[0, 1, 2].map((i) => (
                            <TableRow key={i}>
                                <TableCell>
                                    <Skeleton className="h-4 w-24 rounded-md" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-24 rounded-md" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="size-8 rounded-lg" />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            ) : data.linked.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <PackageOpen />
                        </EmptyMedia>
                        <EmptyTitle>No bridged channels</EmptyTitle>
                        <EmptyDescription>
                            You haven't linked any Discord channels to Fluxer
                            channels yet.
                        </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                        <div className="flex gap-2">
                            <AutolinkDialog
                                guildLinkId={guildLinkId!}
                                disabled={
                                    data.unlinkedDiscordChannels.length === 0 ||
                                    data.unlinkedFluxerChannels.length === 0
                                }
                            />
                            <CreateChannelLinkDialog
                                guildLinkId={guildLinkId!}
                                discordChannels={data.unlinkedDiscordChannels}
                                fluxerChannels={data.unlinkedFluxerChannels}
                            />
                        </div>
                    </EmptyContent>
                </Empty>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Discord channel</TableHead>
                            <TableHead>Fluxer channel</TableHead>
                            <TableHead className="w-px" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.linked.map((link) => (
                            <TableRow key={link.id}>
                                <TableCell>
                                    #{link.discordChannel.name}
                                </TableCell>
                                <TableCell>
                                    #{link.fluxerChannel.name}
                                </TableCell>
                                <TableCell>
                                    <Button
                                        aria-label="Unlink channel"
                                        variant="destructive-outline"
                                        size="icon-sm"
                                        loading={
                                            deleteChannelLink.isPending &&
                                            deleteChannelLink.variables ===
                                                link.id
                                        }
                                        onClick={() =>
                                            deleteChannelLink.mutate(link.id, {
                                                onError: (err) =>
                                                    toastManager.add({
                                                        title: 'Could not unlink channel',
                                                        description:
                                                            err.message,
                                                    }),
                                            })
                                        }
                                    >
                                        <Trash aria-hidden="true" />
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </div>
    );

    return <Layout requiredAuth="either">{content}</Layout>;
}

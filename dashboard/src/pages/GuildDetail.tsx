import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, PackageOpen, Plus, Trash, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogPopup,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import {
    Select,
    SelectItem,
    SelectPopup,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
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
import {
    useAutolinkPreview,
    useCreateChannelLink,
    useDeleteChannelLink,
    useGuildChannels,
    useRunAutolink,
} from '@/api/client';
import type { ChannelSummary } from '../../../src/web/types';
import { Layout } from '../components/Layout';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '../components/ui/empty';

function CreateChannelLinkDialog({
    guildLinkId,
    discordChannels,
    fluxerChannels,
}: {
    guildLinkId: string;
    discordChannels: ChannelSummary[];
    fluxerChannels: ChannelSummary[];
}) {
    const [open, setOpen] = useState(false);
    const [discordId, setDiscordId] = useState<string | null>(null);
    const [fluxerId, setFluxerId] = useState<string | null>(null);
    const createChannelLink = useCreateChannelLink();

    const discordItems = discordChannels.map((c) => ({
        label: `#${c.name}`,
        value: c.id,
    }));
    const fluxerItems = fluxerChannels.map((c) => ({
        label: `#${c.name}`,
        value: c.id,
    }));

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) {
                    setDiscordId(null);
                    setFluxerId(null);
                }
            }}
        >
            <DialogTrigger render={<Button />}>
                <Plus aria-hidden="true" />
                Link a channel
            </DialogTrigger>
            <DialogPopup>
                <DialogHeader>
                    <DialogTitle>Link a channel</DialogTitle>
                </DialogHeader>
                <DialogPanel className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-sm font-medium">
                            Discord channel
                        </label>
                        <Select
                            items={discordItems}
                            value={
                                discordItems.find(
                                    (i) => i.value === discordId
                                ) ?? null
                            }
                            onValueChange={(item) =>
                                setDiscordId(item?.value ?? null)
                            }
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Select a Discord channel" />
                            </SelectTrigger>
                            <SelectPopup>
                                {discordItems.map((item) => (
                                    <SelectItem key={item.value} value={item}>
                                        {item.label}
                                    </SelectItem>
                                ))}
                            </SelectPopup>
                        </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label className="text-sm font-medium">
                            Fluxer channel
                        </label>
                        <Select
                            items={fluxerItems}
                            value={
                                fluxerItems.find((i) => i.value === fluxerId) ??
                                null
                            }
                            onValueChange={(item) =>
                                setFluxerId(item?.value ?? null)
                            }
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Select a Fluxer channel" />
                            </SelectTrigger>
                            <SelectPopup>
                                {fluxerItems.map((item) => (
                                    <SelectItem key={item.value} value={item}>
                                        {item.label}
                                    </SelectItem>
                                ))}
                            </SelectPopup>
                        </Select>
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button variant="ghost" />}>
                        Cancel
                    </DialogClose>
                    <Button
                        type="button"
                        disabled={!discordId || !fluxerId}
                        loading={createChannelLink.isPending}
                        onClick={() => {
                            if (!discordId || !fluxerId) return;
                            createChannelLink.mutate(
                                {
                                    guildLinkId,
                                    discordChannelId: discordId,
                                    fluxerChannelId: fluxerId,
                                },
                                {
                                    onSuccess: () => {
                                        toastManager.add({
                                            title: 'Channels linked',
                                        });
                                        setOpen(false);
                                    },
                                    onError: (err) =>
                                        toastManager.add({
                                            title: 'Could not link channels',
                                            description: err.message,
                                        }),
                                }
                            );
                        }}
                    >
                        Link channels
                    </Button>
                </DialogFooter>
            </DialogPopup>
        </Dialog>
    );
}

function AutolinkDialog({
    guildLinkId,
    disabled,
}: {
    guildLinkId: string;
    disabled: boolean;
}) {
    const [open, setOpen] = useState(false);
    const { data, isLoading } = useAutolinkPreview(guildLinkId, open);
    const runAutolink = useRunAutolink(guildLinkId);

    const proposalCount = data?.proposals.length ?? 0;
    const unmatchedCount =
        (data?.unmatchedDiscordCount ?? 0) + (data?.unmatchedFluxerCount ?? 0);

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
                render={<Button variant="outline" disabled={disabled} />}
            >
                <Wand2 aria-hidden="true" />
                Autolink channels
            </DialogTrigger>
            <DialogPopup className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Autolink channels</DialogTitle>
                    <DialogDescription>
                        Unlinked channels are matched by name. Review the
                        proposed pairs before linking them.
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel className="flex flex-col gap-4">
                    {isLoading || !data ? (
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-9 w-full rounded-md" />
                            <Skeleton className="h-9 w-full rounded-md" />
                            <Skeleton className="h-9 w-full rounded-md" />
                        </div>
                    ) : proposalCount === 0 ? (
                        <p className="text-muted-foreground text-sm">
                            No confident name matches found among the unlinked
                            channels.
                        </p>
                    ) : (
                        <>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Discord channel</TableHead>
                                        <TableHead>Fluxer channel</TableHead>
                                        <TableHead className="w-px">
                                            Match
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {data.proposals.map((p) => (
                                        <TableRow
                                            key={`${p.discordChannel.id}-${p.fluxerChannel.id}`}
                                        >
                                            <TableCell>
                                                #{p.discordChannel.name}
                                            </TableCell>
                                            <TableCell>
                                                #{p.fluxerChannel.name}
                                            </TableCell>
                                            <TableCell>
                                                <Badge
                                                    variant={
                                                        p.score === 1
                                                            ? 'success'
                                                            : 'warning'
                                                    }
                                                >
                                                    {Math.round(p.score * 100)}%
                                                </Badge>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                            {unmatchedCount > 0 && (
                                <p className="text-muted-foreground text-sm">
                                    {unmatchedCount} channel
                                    {unmatchedCount !== 1 ? 's' : ''} had no
                                    confident match and won't be linked.
                                </p>
                            )}
                        </>
                    )}
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button variant="ghost" />}>
                        Cancel
                    </DialogClose>
                    <Button
                        type="button"
                        disabled={proposalCount === 0}
                        loading={runAutolink.isPending}
                        onClick={() =>
                            runAutolink.mutate(undefined, {
                                onSuccess: (result) => {
                                    const failed = result.results.filter(
                                        (r) => r.error
                                    );
                                    toastManager.add(
                                        failed.length === 0
                                            ? {
                                                  type: 'success',
                                                  title: `Linked ${result.linkedCount} channel${result.linkedCount !== 1 ? 's' : ''}`,
                                              }
                                            : {
                                                  type: 'warning',
                                                  title: `Linked ${result.linkedCount} of ${result.results.length} channel pairs`,
                                                  description: `${failed.length} failed. Check the server logs for details.`,
                                              }
                                    );
                                    setOpen(false);
                                },
                                onError: (err) =>
                                    toastManager.add({
                                        title: 'Autolink failed',
                                        description: err.message,
                                    }),
                            })
                        }
                    >
                        Link {proposalCount} channel
                        {proposalCount !== 1 ? 's' : ''}
                    </Button>
                </DialogFooter>
            </DialogPopup>
        </Dialog>
    );
}

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

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
import { useState } from 'react';
import { useAutolinkPreview, useRunAutolink } from '../api/client';
import { Button } from './ui/button';
import { Wand2 } from 'lucide-react';
import { Skeleton } from './ui/skeleton';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { toastManager } from './ui/toast';
import { Badge } from './ui/badge';

export function AutolinkDialog({
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

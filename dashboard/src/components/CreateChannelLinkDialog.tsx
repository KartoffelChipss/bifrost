import {
    Combobox,
    ComboboxCollection,
    ComboboxEmpty,
    ComboboxGroup,
    ComboboxGroupLabel,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxPopup,
    ComboboxSeparator,
} from '@/components/ui/combobox';
import type { UnlinkedChannelSummary } from '../../../src/web/types';
import { Fragment, useState } from 'react';
import { useCreateChannelLink } from '../api/client';
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
import { ArrowLeftRight, Hash, Plus } from 'lucide-react';
import { Button } from './ui/button';
import { toastManager } from '@/components/ui/toast';

type ChannelOption = { label: string; value: string };

type ChannelOptionGroup = {
    key: string;
    label: string | null;
    items: ChannelOption[];
};

function groupChannelOptions(
    channels: UnlinkedChannelSummary[]
): ChannelOptionGroup[] {
    const groups: ChannelOptionGroup[] = [];
    const byKey = new Map<string, ChannelOptionGroup>();

    for (const channel of channels) {
        const key = channel.categoryId ?? '__uncategorized__';
        let group = byKey.get(key);
        if (!group) {
            group = { key, label: channel.categoryName ?? null, items: [] };
            byKey.set(key, group);
            groups.push(group);
        }
        group.items.push({ label: channel.name, value: channel.id });
    }

    return groups;
}

export function CreateChannelLinkDialog({
    guildLinkId,
    discordChannels,
    fluxerChannels,
}: {
    guildLinkId: string;
    discordChannels: UnlinkedChannelSummary[];
    fluxerChannels: UnlinkedChannelSummary[];
}) {
    const [open, setOpen] = useState(false);
    const [discordId, setDiscordId] = useState<string | null>(null);
    const [fluxerId, setFluxerId] = useState<string | null>(null);
    const createChannelLink = useCreateChannelLink();

    const discordGroups = groupChannelOptions(discordChannels);
    const fluxerGroups = groupChannelOptions(fluxerChannels);

    const selectedDiscordItem =
        discordGroups
            .flatMap((g) => g.items)
            .find((i) => i.value === discordId) ?? null;
    const selectedFluxerItem =
        fluxerGroups
            .flatMap((g) => g.items)
            .find((i) => i.value === fluxerId) ?? null;

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
            <DialogPopup className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Link a channel</DialogTitle>
                    <DialogDescription>
                        Messages posted in either channel will be mirrored to
                        the other.
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr]">
                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium">
                                Discord channel
                            </label>
                            <Combobox
                                items={discordGroups}
                                value={selectedDiscordItem}
                                onValueChange={(item) =>
                                    setDiscordId(item?.value ?? null)
                                }
                            >
                                <ComboboxInput
                                    placeholder="Search Discord channels..."
                                    startAddon={
                                        <Hash
                                            aria-hidden="true"
                                            className="size-4.5"
                                        />
                                    }
                                />
                                <ComboboxPopup>
                                    <ComboboxEmpty>
                                        No unlinked Discord channels.
                                    </ComboboxEmpty>
                                    <ComboboxList>
                                        {(
                                            group: ChannelOptionGroup,
                                            index: number
                                        ) => (
                                            <Fragment key={group.key}>
                                                {index > 0 && (
                                                    <ComboboxSeparator />
                                                )}
                                                <ComboboxGroup
                                                    items={group.items}
                                                >
                                                    {group.label && (
                                                        <ComboboxGroupLabel>
                                                            {group.label}
                                                        </ComboboxGroupLabel>
                                                    )}
                                                    <ComboboxCollection>
                                                        {(
                                                            item: ChannelOption
                                                        ) => (
                                                            <ComboboxItem
                                                                key={item.value}
                                                                value={item}
                                                            >
                                                                #{item.label}
                                                            </ComboboxItem>
                                                        )}
                                                    </ComboboxCollection>
                                                </ComboboxGroup>
                                            </Fragment>
                                        )}
                                    </ComboboxList>
                                </ComboboxPopup>
                            </Combobox>
                        </div>

                        <div className="text-muted-foreground hidden items-center justify-center pt-7 sm:flex">
                            <ArrowLeftRight
                                aria-hidden="true"
                                className="size-5"
                            />
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium">
                                Fluxer channel
                            </label>
                            <Combobox
                                items={fluxerGroups}
                                value={selectedFluxerItem}
                                onValueChange={(item) =>
                                    setFluxerId(item?.value ?? null)
                                }
                            >
                                <ComboboxInput
                                    placeholder="Search Fluxer channels..."
                                    startAddon={
                                        <Hash
                                            aria-hidden="true"
                                            className="size-4.5"
                                        />
                                    }
                                />
                                <ComboboxPopup>
                                    <ComboboxEmpty>
                                        No unlinked Fluxer channels.
                                    </ComboboxEmpty>
                                    <ComboboxList>
                                        {(
                                            group: ChannelOptionGroup,
                                            index: number
                                        ) => (
                                            <Fragment key={group.key}>
                                                {index > 0 && (
                                                    <ComboboxSeparator />
                                                )}
                                                <ComboboxGroup
                                                    items={group.items}
                                                >
                                                    {group.label && (
                                                        <ComboboxGroupLabel>
                                                            {group.label}
                                                        </ComboboxGroupLabel>
                                                    )}
                                                    <ComboboxCollection>
                                                        {(
                                                            item: ChannelOption
                                                        ) => (
                                                            <ComboboxItem
                                                                key={item.value}
                                                                value={item}
                                                            >
                                                                #{item.label}
                                                            </ComboboxItem>
                                                        )}
                                                    </ComboboxCollection>
                                                </ComboboxGroup>
                                            </Fragment>
                                        )}
                                    </ComboboxList>
                                </ComboboxPopup>
                            </Combobox>
                        </div>
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
                                            type: 'success',
                                            title: 'Channels linked',
                                        });
                                        setOpen(false);
                                    },
                                    onError: (err) =>
                                        toastManager.add({
                                            type: 'error',
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

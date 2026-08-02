import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
    ArrowLeftRight,
    PackageOpen,
    PackageX,
    Plus,
    Server,
    Unlink,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardPanel } from '@/components/ui/card';
import {
    Combobox,
    ComboboxEmpty,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxPopup,
} from '@/components/ui/combobox';
import {
    Dialog,
    DialogClose,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogPopup,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toastManager } from '@/components/ui/toast';
import {
    useCreateGuildLink,
    useDeleteGuildLink,
    useGuilds,
    useInviteLink,
    useMe,
} from '@/api/client';
import type { GuildSummary } from '../../../src/web/types';
import GuildIcon from '../components/GuildIcon';
import { Layout } from '../components/Layout';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '../components/ui/empty';

function GuildOptionRow({ guild }: { guild: GuildSummary }) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            <GuildIcon guild={guild} className="size-5" />
            <span className="min-w-0 flex-1 truncate">{guild.name}</span>
            {!guild.botPresent && (
                <PackageX
                    aria-label="Bifröst not installed"
                    className="text-muted-foreground size-3.5 shrink-0"
                />
            )}
        </div>
    );
}

function GuildComboboxAddon({ guild }: { guild: GuildSummary | undefined }) {
    if (!guild) {
        return <Server aria-hidden="true" className="size-4.5" />;
    }
    return <GuildIcon guild={guild} className="size-4.5" />;
}

function InviteHint({
    platform,
    guild,
}: {
    platform: 'discord' | 'fluxer';
    guild: GuildSummary;
}) {
    const inviteLink = useInviteLink();
    return (
        <Alert variant="warning" className="mt-1.5">
            <PackageX />
            <AlertDescription className="gap-2">
                <span>Bifröst isn't in {guild.name} yet.</span>
                <Button
                    size="xs"
                    className="self-start"
                    loading={inviteLink.isPending}
                    onClick={() =>
                        inviteLink.mutate(
                            { platform, guildId: guild.id },
                            {
                                onSuccess: (data) =>
                                    window.open(data.url, '_blank', 'noopener'),
                                onError: (err) =>
                                    toastManager.add({
                                        title: 'Could not build invite link',
                                        description: err.message,
                                    }),
                            }
                        )
                    }
                >
                    Invite bot
                </Button>
            </AlertDescription>
        </Alert>
    );
}

function sortByBotPresent(a: GuildSummary, b: GuildSummary) {
    return Number(b.botPresent) - Number(a.botPresent);
}

function CreateGuildLinkDialog({
    discordGuilds,
    fluxerGuilds,
}: {
    discordGuilds: GuildSummary[];
    fluxerGuilds: GuildSummary[];
}) {
    const [open, setOpen] = useState(false);
    const [discordId, setDiscordId] = useState<string | null>(null);
    const [fluxerId, setFluxerId] = useState<string | null>(null);
    const createGuildLink = useCreateGuildLink();

    const discordItems = [...discordGuilds]
        .sort(sortByBotPresent)
        .map((guild) => ({ label: guild.name, value: guild.id, guild }));
    const fluxerItems = [...fluxerGuilds]
        .sort(sortByBotPresent)
        .map((guild) => ({ label: guild.name, value: guild.id, guild }));

    const selectedDiscordItem =
        discordItems.find((i) => i.value === discordId) ?? null;
    const selectedFluxerItem =
        fluxerItems.find((i) => i.value === fluxerId) ?? null;

    const discordNeedsInvite =
        selectedDiscordItem !== null && !selectedDiscordItem.guild.botPresent;
    const fluxerNeedsInvite =
        selectedFluxerItem !== null && !selectedFluxerItem.guild.botPresent;

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
                Link a server
            </DialogTrigger>
            <DialogPopup className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        Link a Discord server to a Fluxer guild
                    </DialogTitle>
                </DialogHeader>
                <DialogPanel className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr]">
                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium">
                                Discord server
                            </label>
                            <Combobox
                                items={discordItems}
                                value={selectedDiscordItem}
                                onValueChange={(item) =>
                                    setDiscordId(item?.value ?? null)
                                }
                            >
                                <ComboboxInput
                                    placeholder="Search Discord servers..."
                                    startAddon={
                                        <GuildComboboxAddon
                                            guild={selectedDiscordItem?.guild}
                                        />
                                    }
                                />
                                <ComboboxPopup>
                                    <ComboboxEmpty>
                                        No servers found.
                                    </ComboboxEmpty>
                                    <ComboboxList>
                                        {(item) => (
                                            <ComboboxItem
                                                key={item.value}
                                                value={item}
                                            >
                                                <GuildOptionRow
                                                    guild={item.guild}
                                                />
                                            </ComboboxItem>
                                        )}
                                    </ComboboxList>
                                </ComboboxPopup>
                            </Combobox>
                            {selectedDiscordItem && discordNeedsInvite && (
                                <InviteHint
                                    platform="discord"
                                    guild={selectedDiscordItem.guild}
                                />
                            )}
                        </div>

                        <div className="text-muted-foreground hidden items-center justify-center pt-7 sm:flex">
                            <ArrowLeftRight
                                aria-hidden="true"
                                className="size-5"
                            />
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium">
                                Fluxer guild
                            </label>
                            <Combobox
                                items={fluxerItems}
                                value={selectedFluxerItem}
                                onValueChange={(item) =>
                                    setFluxerId(item?.value ?? null)
                                }
                            >
                                <ComboboxInput
                                    placeholder="Search Fluxer guilds..."
                                    startAddon={
                                        <GuildComboboxAddon
                                            guild={selectedFluxerItem?.guild}
                                        />
                                    }
                                />
                                <ComboboxPopup>
                                    <ComboboxEmpty>
                                        No guilds found.
                                    </ComboboxEmpty>
                                    <ComboboxList>
                                        {(item) => (
                                            <ComboboxItem
                                                key={item.value}
                                                value={item}
                                            >
                                                <GuildOptionRow
                                                    guild={item.guild}
                                                />
                                            </ComboboxItem>
                                        )}
                                    </ComboboxList>
                                </ComboboxPopup>
                            </Combobox>
                            {selectedFluxerItem && fluxerNeedsInvite && (
                                <InviteHint
                                    platform="fluxer"
                                    guild={selectedFluxerItem.guild}
                                />
                            )}
                        </div>
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button variant="ghost" />}>
                        Cancel
                    </DialogClose>
                    <Button
                        type="button"
                        disabled={
                            !discordId ||
                            !fluxerId ||
                            discordNeedsInvite ||
                            fluxerNeedsInvite
                        }
                        loading={createGuildLink.isPending}
                        onClick={() => {
                            if (!discordId || !fluxerId) return;
                            createGuildLink.mutate(
                                {
                                    discordGuildId: discordId,
                                    fluxerGuildId: fluxerId,
                                },
                                {
                                    onSuccess: () => {
                                        toastManager.add({
                                            title: 'Servers linked',
                                        });
                                        setOpen(false);
                                    },
                                    onError: (err) =>
                                        toastManager.add({
                                            title: 'Could not link servers',
                                            description: err.message,
                                        }),
                                }
                            );
                        }}
                    >
                        Link servers
                    </Button>
                </DialogFooter>
            </DialogPopup>
        </Dialog>
    );
}

export function Home() {
    const { data: me } = useMe();
    const { data: guilds, isLoading } = useGuilds();
    const deleteGuildLink = useDeleteGuildLink();

    if (isLoading || !guilds) {
        return (
            <Layout requiredAuth="either">
                <div className="flex flex-col gap-3">
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-20 w-full" />
                </div>
            </Layout>
        );
    }

    const canCreateLink =
        me?.discord &&
        me?.fluxer &&
        guilds.unlinkedDiscordGuilds.length > 0 &&
        guilds.unlinkedFluxerGuilds.length > 0;

    return (
        <Layout requiredAuth="either">
            <div className="flex flex-col gap-8">
                <div className="flex items-center justify-between">
                    <h1 className="text-xl font-semibold">Bridged servers</h1>
                    {canCreateLink && (
                        <CreateGuildLinkDialog
                            discordGuilds={guilds.unlinkedDiscordGuilds}
                            fluxerGuilds={guilds.unlinkedFluxerGuilds}
                        />
                    )}
                </div>

                <section className="flex flex-col gap-3">
                    {guilds.linkedPairs.length === 0 && (
                        <Empty>
                            <EmptyHeader>
                                <EmptyMedia variant="icon">
                                    <PackageOpen />
                                </EmptyMedia>
                                <EmptyTitle>No bridged servers</EmptyTitle>
                                <EmptyDescription>
                                    You haven't linked any Discord servers to
                                    Fluxer guilds yet.
                                </EmptyDescription>
                            </EmptyHeader>
                            <EmptyContent>
                                <div className="flex gap-2">
                                    {canCreateLink && (
                                        <CreateGuildLinkDialog
                                            discordGuilds={
                                                guilds.unlinkedDiscordGuilds
                                            }
                                            fluxerGuilds={
                                                guilds.unlinkedFluxerGuilds
                                            }
                                        />
                                    )}
                                </div>
                            </EmptyContent>
                        </Empty>
                    )}
                    {guilds.linkedPairs.map((pair) => (
                        <Card key={pair.guildLinkId}>
                            <CardPanel className="flex items-center justify-between gap-4">
                                <Link
                                    to={`/guilds/${pair.guildLinkId}`}
                                    className="flex flex-1 items-center gap-6"
                                >
                                    <div className="flex items-center gap-2">
                                        <GuildIcon guild={pair.discord} />
                                        <span>{pair.discord.name}</span>
                                        {!pair.discord.botPresent && (
                                            <Badge variant="warning">
                                                Bot missing
                                            </Badge>
                                        )}
                                    </div>
                                    <span className="text-muted-foreground">
                                        &harr;
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <GuildIcon guild={pair.fluxer} />
                                        <span>{pair.fluxer.name}</span>
                                        {!pair.fluxer.botPresent && (
                                            <Badge variant="warning">
                                                Bot missing
                                            </Badge>
                                        )}
                                    </div>
                                </Link>
                                <Button
                                    aria-label="Unlink servers"
                                    variant="ghost"
                                    size="icon-sm"
                                    loading={
                                        deleteGuildLink.isPending &&
                                        deleteGuildLink.variables ===
                                            pair.guildLinkId
                                    }
                                    onClick={() =>
                                        deleteGuildLink.mutate(
                                            pair.guildLinkId,
                                            {
                                                onError: (err) =>
                                                    toastManager.add({
                                                        title: 'Could not unlink servers',
                                                        description:
                                                            err.message,
                                                    }),
                                            }
                                        )
                                    }
                                >
                                    <Unlink aria-hidden="true" />
                                </Button>
                            </CardPanel>
                        </Card>
                    ))}
                </section>
            </div>
        </Layout>
    );
}

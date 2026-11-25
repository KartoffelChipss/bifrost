import { useState } from 'react';
import {
    useAccountLinks,
    useCreateAccountLink,
    useDeleteAccountLink,
} from '../api/client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { AccountLinkSummary } from '../../../src/web/types';

function Account({
    id,
    identity,
}: {
    id: string;
    identity: AccountLinkSummary['discord'];
}) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            <div className="size-8 shrink-0">
                {identity?.avatarURL && (
                    <img
                        src={identity.avatarURL}
                        alt=""
                        className="size-8 rounded-full"
                    />
                )}
            </div>
            <div className="min-w-0 break-words">
                <div>{identity?.username || id}</div>
                <div className="break-all text-xs text-muted-foreground">
                    {id}
                </div>
                {!identity && (
                    <div className="text-sm text-amber-600">
                        Account unavailable
                    </div>
                )}
            </div>
        </div>
    );
}

export function AccountLinks() {
    const [discordUserId, setDiscordUserId] = useState('');
    const [fluxerUserId, setFluxerUserId] = useState('');
    const query = useAccountLinks();
    const create = useCreateAccountLink();
    const remove = useDeleteAccountLink();
    const isPending = create.isPending || remove.isPending;
    const error = create.error || remove.error;
    return (
        <section className="flex flex-col gap-4 rounded-lg border p-4">
            <h2 className="text-lg font-semibold">Account links</h2>
            <p className="text-sm text-muted-foreground">
                Link accounts across this instance. Destination servers must
                enable linked names and avatars. Account ownership is not
                verified.
            </p>
            {query.isPending ? (
                <p>Loading account links…</p>
            ) : query.error ? (
                <p role="alert">{query.error.message}</p>
            ) : (
                <>
                    <p
                        id="account-id-guide"
                        className="text-sm text-muted-foreground"
                    >
                        Use Copy User ID in each platform. Enable Developer Mode
                        in Discord first.
                    </p>
                    <form
                        className="grid grid-cols-1 items-end gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem]"
                        onSubmit={(event) => {
                            event.preventDefault();
                            remove.reset();
                            create.mutate(
                                {
                                    discordUserId: discordUserId.trim(),
                                    fluxerUserId: fluxerUserId.trim(),
                                },
                                {
                                    onSuccess: () => {
                                        setDiscordUserId('');
                                        setFluxerUserId('');
                                    },
                                }
                            );
                        }}
                    >
                        <label className="flex flex-col gap-1">
                            Discord account ID
                            <Input
                                value={discordUserId}
                                onChange={(event) =>
                                    setDiscordUserId(event.target.value)
                                }
                                required
                                inputMode="numeric"
                                placeholder="e.g. 123456789012345678"
                                aria-describedby="account-id-guide"
                                pattern="[1-9][0-9]{0,19}"
                            />
                        </label>
                        <label className="flex flex-col gap-1">
                            Fluxer account ID
                            <Input
                                value={fluxerUserId}
                                onChange={(event) =>
                                    setFluxerUserId(event.target.value)
                                }
                                required
                                inputMode="numeric"
                                placeholder="e.g. 123456789012345678"
                                aria-describedby="account-id-guide"
                                pattern="[1-9][0-9]{0,19}"
                            />
                        </label>
                        <Button type="submit" disabled={isPending}>
                            Link accounts
                        </Button>
                    </form>
                    {query.data?.length === 0 && <p>No linked accounts.</p>}
                    {query.data?.map((link) => (
                        <div
                            key={link.id}
                            className="grid grid-cols-1 items-center gap-4 border-t pt-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem]"
                        >
                            <div>
                                <span className="text-xs">Discord</span>
                                <Account
                                    id={link.discordUserId}
                                    identity={link.discord}
                                />
                            </div>
                            <div>
                                <span className="text-xs">Fluxer</span>
                                <Account
                                    id={link.fluxerUserId}
                                    identity={link.fluxer}
                                />
                            </div>
                            <Button
                                variant="outline"
                                disabled={isPending}
                                onClick={() => {
                                    create.reset();
                                    remove.mutate(link.id);
                                }}
                            >
                                Unlink accounts
                            </Button>
                        </div>
                    ))}
                </>
            )}
            {error && <p role="alert">{error.message}</p>}
        </section>
    );
}

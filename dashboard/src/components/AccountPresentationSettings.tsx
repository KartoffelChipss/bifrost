import {
    useAccountPresentation,
    useSetAccountPresentation,
} from '../api/client';
import { Checkbox } from './ui/checkbox';
import { toastManager } from './ui/toast';

export function AccountPresentationSettings({
    guildLinkId,
}: {
    guildLinkId: string;
}) {
    const query = useAccountPresentation(guildLinkId);
    const update = useSetAccountPresentation(guildLinkId);
    return (
        <section className="flex flex-col gap-4 rounded-lg border p-4">
            <h2 className="text-lg font-semibold">
                Linked account presentation
            </h2>
            <p className="text-sm text-muted-foreground">
                Use destination names and avatars from owner-managed account
                links. Ownership is not verified. Changes apply to new messages,
                not queued messages.
            </p>
            {query.isPending ? (
                <p>Loading settings…</p>
            ) : query.error ? (
                <p role="alert">{query.error.message}</p>
            ) : (
                (['discord', 'fluxer'] as const).map((platform) => (
                    <label key={platform} className="flex items-center gap-2">
                        <Checkbox
                            checked={query.data[platform].enabled}
                            disabled={
                                !query.data[platform].canManage ||
                                update.isPending
                            }
                            onCheckedChange={(enabled) =>
                                update.mutate(
                                    { platform, enabled },
                                    {
                                        onError: (err) =>
                                            toastManager.add({
                                                title: 'Could not update account presentation',
                                                description: err.message,
                                            }),
                                    }
                                )
                            }
                        />
                        Use linked names and avatars in{' '}
                        {platform === 'discord' ? 'Discord' : 'Fluxer'}
                    </label>
                ))
            )}
        </section>
    );
}

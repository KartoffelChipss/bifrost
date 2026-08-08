import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LogOut, ShieldUser } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useLogout, useMe } from '@/api/client';
import type { Identity } from '../../../src/web/types';
import { PlatformLoginButton } from './PlatformLoginButton';
import LoginPrompt from './LoginPrompt';

function IdentityChip({
    platform,
    identity,
}: {
    platform: 'discord' | 'fluxer';
    identity: Identity | null | undefined;
}) {
    if (!identity) {
        return (
            <PlatformLoginButton
                platform={platform}
                href={`/api/auth/${platform}/login`}
                size="sm"
            />
        );
    }
    return (
        <div className="flex items-center gap-2 rounded-lg border px-2 py-1">
            <Avatar className="size-6">
                {identity.avatarUrl && (
                    <AvatarImage
                        src={identity.avatarUrl}
                        alt={identity.username}
                    />
                )}
                <AvatarFallback>
                    {identity.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
            </Avatar>
            <span className="text-sm">{identity.username}</span>
        </div>
    );
}

export function Layout({
    children,
    title,
    requiredAuth = 'either',
}: {
    children: ReactNode;
    title?: string;
    requiredAuth?: 'none' | 'either' | 'both';
}) {
    const { data: me } = useMe();
    const logout = useLogout();

    useEffect(() => {
        if (title) {
            document.title = `${title} | Bifröst Dashboard`;
        } else {
            document.title = 'Bifröst Dashboard';
        }
    }, [title]);

    const missingAuth =
        (requiredAuth === 'either' && !me?.discord && !me?.fluxer) ||
        (requiredAuth === 'both' && (!me?.discord || !me?.fluxer));

    return (
        <div className="mx-auto flex min-h-svh max-w-5xl flex-col gap-6 px-4 py-6">
            <header className="flex items-center justify-between gap-4">
                <Link
                    to="/"
                    className="text-lg font-semibold flex items-center gap-2"
                >
                    <img
                        src="/logo.svg"
                        alt="Bifröst Logo"
                        className="h-8 w-8"
                    />
                    Bifröst Dashboard
                </Link>
                <div className="flex items-center gap-2">
                    {me?.isOwner && (
                        <Button
                            aria-label="Admin dashboard"
                            variant="ghost"
                            size="icon-sm"
                            render={<Link to="/admin" />}
                        >
                            <ShieldUser aria-hidden="true" />
                        </Button>
                    )}
                    <IdentityChip platform="discord" identity={me?.discord} />
                    <IdentityChip platform="fluxer" identity={me?.fluxer} />
                    {(me?.discord || me?.fluxer) && (
                        <Button
                            aria-label="Log out"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => logout.mutate()}
                        >
                            <LogOut aria-hidden="true" />
                        </Button>
                    )}
                </div>
            </header>
            <main className="flex-1">
                {missingAuth ? <LoginPrompt /> : children}
            </main>
        </div>
    );
}

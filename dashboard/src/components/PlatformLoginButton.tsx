import { DiscordIcon } from '../icons/DiscordIcon';
import { FluxerIcon } from '../icons/FluxerIcon';
import { cn } from '../lib/utils';
import { Button, type ButtonProps } from './ui/button';

const PLATFORM = {
    discord: {
        label: 'Discord',
        Icon: DiscordIcon,
        className:
            'bg-[#5865F2] hover:bg-[#5865F2]/90 data-pressed:bg-[#5865F2]/90 text-white border-transparent',
    },
    fluxer: {
        label: 'Fluxer',
        Icon: FluxerIcon,
        className:
            'bg-[#4641D9] hover:bg-[#4641D9]/90 data-pressed:bg-[#4641D9]/90 text-white border-transparent',
    },
} as const;

export function PlatformLoginButton({
    platform,
    href,
    className,
    children,
    ...props
}: {
    platform: keyof typeof PLATFORM;
    href: string;
} & Omit<ButtonProps, 'render'>) {
    const { label, Icon, className: brandClassName } = PLATFORM[platform];

    return (
        <Button
            render={<a href={href} />}
            className={cn(brandClassName, className)}
            {...props}
        >
            <Icon aria-hidden="true" className="size-4" />
            {children ?? `Connect ${label}`}
        </Button>
    );
}

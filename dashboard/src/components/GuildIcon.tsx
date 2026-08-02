import type { GuildSummary } from '../../../src/web/types';
import { cn } from '../lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';

function GuildIcon({
    guild,
    className,
}: {
    guild: GuildSummary;
    className?: string;
}) {
    return (
        <Avatar className={cn('size-8', className)}>
            {guild.icon && <AvatarImage src={guild.icon} alt="" />}
            <AvatarFallback className="text-[0.6em]">
                {guild.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
        </Avatar>
    );
}

export default GuildIcon;

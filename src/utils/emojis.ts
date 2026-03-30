import { GuildEmoji as FluxerEmoji } from '@fluxerjs/core';
import { GuildEmoji as DiscordEmoji } from 'discord.js';

export function emojiToString(
    emoji: FluxerEmoji | DiscordEmoji | GeneralEmoji
): string {
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

export type GeneralEmoji = {
    animated: boolean;
    name: string;
    id: string;
};

export function replaceEmojis(
    content: string,
    fn: (emoji: GeneralEmoji) => string
): string {
    const emojiRegex = /<(a?):([a-zA-Z0-9_]+):(\d+)>/g;

    return content.replace(emojiRegex, (_, animated, name, id) => {
        const emoji: GeneralEmoji = {
            animated: animated === 'a',
            name,
            id,
        };

        return fn(emoji);
    });
}

type MentionResolver = {
    resolveUser: (id: string) => string | null;
    resolveRole: (id: string) => string | null;
    resolveChannel: (id: string) => string | null;
};

export function sanitizeMentions(content: string, resolver: MentionResolver): string {
    return content.replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, (match) => {
        if (match.startsWith('<@') && !match.startsWith('<@&') && !match.startsWith('<#')) {
            const id = match.replace(/[<@!>]/g, '');
            const username = resolver.resolveUser(id);
            return username ? `@${username}` : '@unknown-user';
        }

        if (match.startsWith('<@&')) {
            const id = match.replace(/[<@&>]/g, '');
            const roleName = resolver.resolveRole(id);
            return roleName ? `@${roleName}` : '@unknown-role';
        }

        if (match.startsWith('<#')) {
            const id = match.replace(/[<#>]/g, '');
            const channelName = resolver.resolveChannel(id);
            return channelName ? `#${channelName}` : '#unknown-channel';
        }

        return match;
    });
}

export function breakMentions(content: string): string {
    return content.replace(/@/g, '@\u200B');
}

export function escapeMentions(content: string): string {
    return content
        .replace(/@everyone/g, '`@everyone`')
        .replace(/@here/g, '`@here`')
        .replace(/<@\w+>/g, (m) => `\`${m}\``);
}

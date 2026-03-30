export const formatJoinMessage = (
    username: string,
    platform: 'discord' | 'fluxer'
): string => {
    const platformName = platform === 'discord' ? 'Discord' : 'Fluxer';
    return `**${username}** has joined the ${platformName} server!`;
};

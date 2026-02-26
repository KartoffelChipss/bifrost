export const generateDiscordBotInviteLink = (clientId: string, permissions: string) => {
    return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&integration_type=0&scope=bot`;
};

export const generateFluxerBotInviteLink = (clientId: string, permissions: string) => {
    return `https://web.fluxer.app/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${permissions}`;
};

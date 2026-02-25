import { getUsageMessage } from '../utils/usageMessage';

interface CommandInfo {
    description: string;
    usageArgs: string[];
}

interface Command {
    name: string;
    discord: CommandInfo;
    fluxer: CommandInfo;
}

const commandList: Command[] = [
    {
        name: 'help',
        discord: {
            description: 'Displays a list of available commands and their descriptions.',
            usageArgs: [],
        },
        fluxer: {
            description: 'Displays a list of available commands and their descriptions.',
            usageArgs: [],
        },
    },
    {
        name: 'linkguild',
        discord: {
            description: 'Creates a link between this Discord guild and a Fluxer guild.',
            usageArgs: ['<fluxerGuildId>'],
        },
        fluxer: {
            description: 'Creates a link between this Fluxer guild and a Discord guild.',
            usageArgs: ['<discordGuildId>'],
        },
    },
    {
        name: 'linkchannel',
        discord: {
            description: 'Links the current Discord channel to a Fluxer channel.',
            usageArgs: ['<fluxerChannelId>'],
        },
        fluxer: {
            description: 'Links the current Fluxer channel to a Discord channel.',
            usageArgs: ['<discordChannelId>'],
        },
    },
    {
        name: 'listchannels',
        discord: {
            description: 'Lists all channels linked in the current Discord guild.',
            usageArgs: [],
        },
        fluxer: {
            description: 'Lists all channels linked in the current Fluxer guild.',
            usageArgs: [],
        },
    },
    {
        name: 'unlinkchannel',
        discord: {
            description: 'Unlinks a channel link. Get the link ID from the listchannels command.',
            usageArgs: ['<link-id>'],
        },
        fluxer: {
            description: 'Unlinks a channel link. Get the link ID from the listchannels command.',
            usageArgs: ['<link-id>'],
        },
    },
];

export const getCommandUsage = (commandName: string, platform: 'discord' | 'fluxer'): string => {
    const command = commandList.find((cmd) => cmd.name === commandName);
    if (!command) {
        return `Command \`${commandName}\` not found.`;
    }
    const commandInfo = platform === 'discord' ? command.discord : command.fluxer;
    return getUsageMessage(command.name, commandInfo.usageArgs, commandInfo.description);
};

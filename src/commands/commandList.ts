import { COMMAND_PREFIX } from '../utils/env';

export interface CommandInfo {
    description: string;
    usageArgs: string[];
}

export interface Command {
    name: string;
    discord: CommandInfo;
    fluxer: CommandInfo;
}

export type CommandPlatform = 'discord' | 'fluxer';

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
        name: 'unlinkguild',
        discord: {
            description: 'Unlinks this Discord guild from its linked Fluxer guild.',
            usageArgs: [],
        },
        fluxer: {
            description: 'Unlinks this Fluxer guild from its linked Discord guild.',
            usageArgs: [],
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

export const getCommandUsage = (commandName: string, platform: CommandPlatform): string => {
    const command = commandList.find((cmd) => cmd.name === commandName);
    if (!command) return `Command \`${commandName}\` not found.`;
    const commandInfo = platform === 'discord' ? command.discord : command.fluxer;
    const baseMessage = `Usage: \`${COMMAND_PREFIX}${commandName} ${commandInfo.usageArgs.join(' ')}\``;
    return `${baseMessage}\n> ${commandInfo.description}`;
};

export const getHelpMessage = (platform: CommandPlatform): string => {
    function getHelpLine(command: Command): string {
        const usage =
            command.discord.usageArgs && command.discord.usageArgs.length > 0
                ? `${COMMAND_PREFIX}${command.name} ${command.discord.usageArgs.join(' ')}`
                : `${COMMAND_PREFIX}${command.name}`;
        return `- \`${usage}\`: ${platform === 'discord' ? command.discord.description : command.fluxer.description}`;
    }

    const helpMessage = `
**Available Commands:**
${commandList.map((cmd) => getHelpLine(cmd)).join('\n')}

Use \`${COMMAND_PREFIX}<command>\` to execute a command. For example, \`${COMMAND_PREFIX}ping\`.
    `;

    return helpMessage;
};

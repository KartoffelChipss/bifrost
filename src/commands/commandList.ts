import {
    EmbedBuilder as DiscordEmbedBuilder,
    MessageReplyOptions,
} from 'discord.js';
import { COMMAND_PREFIX } from '../utils/env';
import {
    MessageSendOptions,
    EmbedBuilder as FluxerEmbedBuilder,
} from '@fluxerjs/core';
import { EmbedColors } from '../utils/embeds';

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
            description:
                'Displays a list of available commands and their descriptions.',
            usageArgs: [],
        },
        fluxer: {
            description:
                'Displays a list of available commands and their descriptions.',
            usageArgs: [],
        },
    },
    {
        name: 'linkguild',
        discord: {
            description:
                'Creates a link between this Discord guild and a Fluxer guild.',
            usageArgs: ['<fluxerGuildId>'],
        },
        fluxer: {
            description:
                'Creates a link between this Fluxer guild and a Discord guild.',
            usageArgs: ['<discordGuildId>'],
        },
    },
    {
        name: 'unlinkguild',
        discord: {
            description:
                'Unlinks this Discord guild from its linked Fluxer guild.',
            usageArgs: [],
        },
        fluxer: {
            description:
                'Unlinks this Fluxer guild from its linked Discord guild.',
            usageArgs: [],
        },
    },
    {
        name: 'linkchannel',
        discord: {
            description:
                'Links the current Discord channel to a Fluxer channel.',
            usageArgs: ['<fluxerChannelId>'],
        },
        fluxer: {
            description:
                'Links the current Fluxer channel to a Discord channel.',
            usageArgs: ['<discordChannelId>'],
        },
    },
    {
        name: 'listchannels',
        discord: {
            description:
                'Lists all channels linked in the current Discord guild.',
            usageArgs: [],
        },
        fluxer: {
            description:
                'Lists all channels linked in the current Fluxer guild.',
            usageArgs: [],
        },
    },
    {
        name: 'unlinkchannel',
        discord: {
            description:
                'Unlinks the current Discord channel from its linked Fluxer channel.',
            usageArgs: [],
        },
        fluxer: {
            description:
                'Unlinks the current Fluxer channel from its linked Discord channel.',
            usageArgs: [],
        },
    },
    {
        name: 'stats',
        discord: {
            description:
                'Shows statistics about the bot, such as number of linked guilds and channels.',
            usageArgs: [],
        },
        fluxer: {
            description:
                'Shows statistics about the bot, such as number of linked guilds and channels.',
            usageArgs: [],
        },
    },
    {
        name: 'autolink',
        discord: {
            description:
                'Compares unlinked channels across both guilds and proposes links based on name similarity. Run with `confirm` to execute all proposals.',
            usageArgs: ['[confirm]'],
        },
        fluxer: {
            description:
                'Compares unlinked channels across both guilds and proposes links based on name similarity. Run with `confirm` to execute all proposals.',
            usageArgs: ['[confirm]'],
        },
    },
];

function getStringCommandUsage(
    commandName: string,
    platform: CommandPlatform
): string {
    const command = commandList.find((cmd) => cmd.name === commandName);
    if (!command) return `Command \`${commandName}\` not found.`;
    const commandInfo =
        platform === 'discord' ? command.discord : command.fluxer;
    const baseMessage = `Usage: \`${COMMAND_PREFIX}${commandName} ${commandInfo.usageArgs.join(' ')}\``;
    return `${baseMessage}\n> ${commandInfo.description}`;
}

export function getDiscordCommandUsage(
    commandName: string
): MessageReplyOptions {
    const usageMessage = getStringCommandUsage(commandName, 'discord');
    return {
        embeds: [
            new DiscordEmbedBuilder()
                .setTitle('Command Usage')
                .setDescription(usageMessage)
                .setColor(EmbedColors.Info),
        ],
    };
}
export function getFluxerCommandUsage(commandName: string): MessageSendOptions {
    const usageMessage = getStringCommandUsage(commandName, 'fluxer');
    return {
        embeds: [
            new FluxerEmbedBuilder()
                .setTitle('Command Usage')
                .setDescription(usageMessage)
                .setColor(EmbedColors.Info),
        ],
    };
}

export const getHelpMessage = (platform: CommandPlatform): string => {
    function getHelpLine(command: Command): string {
        const commandInfo =
            platform === 'discord' ? command.discord : command.fluxer;

        const usage =
            commandInfo.usageArgs && commandInfo.usageArgs.length > 0
                ? `${COMMAND_PREFIX}${command.name} ${commandInfo.usageArgs.join(' ')}`
                : `${COMMAND_PREFIX}${command.name}`;

        return `- \`${usage}\`: ${commandInfo.description}`;
    }

    const helpMessage = `
**Available Commands:**
${commandList.map((cmd) => getHelpLine(cmd)).join('\n')}

Use \`${COMMAND_PREFIX}<command>\` to execute a command.

-# [Privacy Policy](https://bifrost-bot.com/legal/privacy) | [Terms of Service](https://bifrost-bot.com/legal/tos) | [Support Server](https://fluxer.gg/TN8FkpdQ) | [GitHub](https://github.com/KartoffelChipss/bifrost)
    `;

    return helpMessage;
};

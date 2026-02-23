import { COMMAND_PREFIX } from './env';

export const getUsageMessage = (
    commandName: string,
    args: string[],
    description?: string
): string => {
    const baseMessage = `Usage: \`${COMMAND_PREFIX}${commandName} ${args.join(' ')}\``;
    return description ? `${baseMessage}\n> ${description}` : baseMessage;
};

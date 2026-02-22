export const isCommandString = (str: string, prefix: string): boolean => {
    return str.startsWith(prefix);
};

export const parseCommandString = (
    str: string,
    prefix: string
): { command: string; args: string[] } => {
    if (!isCommandString(str, prefix)) {
        throw new Error(`String does not start with the prefix "${prefix}"`);
    }

    const withoutPrefix = str.slice(prefix.length).trim();
    const parts = withoutPrefix.split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    return { command, args };
};

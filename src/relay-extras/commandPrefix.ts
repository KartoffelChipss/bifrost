import { isCommandString } from '../commands/parseCommandString';
import { defuseCommand } from '../history/format';

/**
 * Upstream runs a message that starts with its command prefix as a command
 * on both platforms. Its channel relay never copies such a message, and
 * its webhook skip covers only bridged channels, not threads. The live
 * relays follow the same rules:
 *
 * - a command message is not relayed;
 * - a copy that would start with the prefix gets a leading zero-width
 *   space, so it cannot run as a command on the other side.
 */

/** Upstream's default prefix, as src/utils/env.ts sets it. */
export const DEFAULT_COMMAND_PREFIX = '!b ';

/**
 * Upstream's command prefix (BF_COMMAND_PREFIX). Read here rather than
 * from src/utils/env.ts, which exits the process when tokens are missing.
 */
export function upstreamCommandPrefix(
    env: NodeJS.ProcessEnv = process.env
): string {
    return env.BF_COMMAND_PREFIX || DEFAULT_COMMAND_PREFIX;
}

/** True for a message upstream would run as a command. */
export function isCommandMessage(
    content: string | null | undefined,
    prefix: string
): boolean {
    return prefix !== '' && isCommandString(content ?? '', prefix);
}

/** The content with a leading command prefix made harmless. */
export function defuseContent(content: string, prefix: string): string {
    return defuseCommand(content, prefix);
}

import { isCommandString } from '../commands/parseCommandString';
import { RollingLimit } from './limits';
import type { Side } from './store';

/** DMs answered per user per minute. Extra DMs are ignored without a reply. */
export const MAX_DMS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;
/** Users whose DM counts are kept at once. */
const MAX_TRACKED_USERS = 10_000;

/**
 * Decides which DMs the identity add-on answers. A DM that starts with the
 * bot's command prefix belongs to upstream's commands, which also run in
 * DMs, so identity stays silent and the member gets one reply, not two.
 */
export class DmGate {
    private readonly limit = new RollingLimit(
        MAX_DMS_PER_MINUTE,
        MINUTE_MS,
        MAX_TRACKED_USERS
    );

    constructor(private readonly commandPrefix: string) {}

    /** True when identity should answer this DM. Counts it if so. */
    admit(side: Side, userId: string, text: string, now: number): boolean {
        if (this.isCommand(text)) return false;
        return this.limit.take(`${side}:${userId}`, 1, now) === 1;
    }

    private isCommand(text: string): boolean {
        // An empty prefix would match every DM; upstream never uses one.
        return (
            this.commandPrefix !== '' &&
            isCommandString(text, this.commandPrefix)
        );
    }
}

import { GatewayIntentBits, Partials } from 'discord.js';
import type { AddonConfig } from './config';
import type { AddonDatabaseState } from './db/migrator';
import { addonDatabaseState } from './state';

/**
 * Extra Discord gateway intents the enabled add-ons need.
 *
 * Guild Members is a privileged intent. Discord refuses the login if it is
 * requested but not enabled for the bot in the developer portal, which would
 * also take the relay down. It is requested only when identity is on.
 *
 * Guild Message Reactions (not privileged) feeds the live reaction relay
 * that starts with guild-sync (src/relay-extras).
 */
export function addonDiscordIntents(
    config: AddonConfig,
    databaseState: AddonDatabaseState | null = addonDatabaseState()
): GatewayIntentBits[] {
    // Add-ons stay off after a failed migration; upstream's intents stand.
    if (databaseState === 'failed') return [];
    const intents = new Set<GatewayIntentBits>();
    if (config.guildSync) {
        intents.add(GatewayIntentBits.GuildExpressions);
        intents.add(GatewayIntentBits.GuildMessageReactions);
    }
    if (config.identity) {
        intents.add(GatewayIntentBits.GuildMembers);
        intents.add(GatewayIntentBits.DirectMessages);
        intents.add(GatewayIntentBits.GuildModeration); // identity: ban events
    }
    return [...intents];
}

/**
 * Extra discord.js partials the enabled add-ons need. Without them,
 * discord.js drops a reaction on an uncached message (Reaction) or by an
 * uncached user (User). Upstream already enables Message and Channel.
 */
export function addonDiscordPartials(
    config: AddonConfig,
    databaseState: AddonDatabaseState | null = addonDatabaseState()
): Partials[] {
    if (databaseState === 'failed') return [];
    return config.guildSync ? [Partials.Reaction, Partials.User] : [];
}

/**
 * Whether upstream's `!b` commands may run for a message. Without the
 * Direct Messages intent the bot never sees a DM, so upstream's commands
 * only ever ran in servers. Identity asks for that intent to read link
 * codes in DMs; upstream's commands must still stay in servers, where
 * their permission checks have a member to look at.
 */
export function upstreamCommandAllowed(
    inGuild: boolean,
    extraIntents: readonly GatewayIntentBits[]
): boolean {
    return inGuild || !extraIntents.includes(GatewayIntentBits.DirectMessages);
}

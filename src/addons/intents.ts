import { GatewayIntentBits, Partials } from 'discord.js';
import type { AddonConfig } from './config';

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
export function addonDiscordIntents(config: AddonConfig): GatewayIntentBits[] {
    const intents = new Set<GatewayIntentBits>();
    if (config.guildSync) {
        intents.add(GatewayIntentBits.GuildExpressions);
        intents.add(GatewayIntentBits.GuildMessageReactions);
    }
    if (config.identity) {
        intents.add(GatewayIntentBits.GuildMembers);
        intents.add(GatewayIntentBits.DirectMessages);
    }
    return [...intents];
}

/**
 * Extra discord.js partials the enabled add-ons need. Without them,
 * discord.js drops a reaction on an uncached message (Reaction) or by an
 * uncached user (User). Upstream already enables Message and Channel.
 */
export function addonDiscordPartials(config: AddonConfig): Partials[] {
    return config.guildSync ? [Partials.Reaction, Partials.User] : [];
}

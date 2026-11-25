import type { Client } from 'discord.js';
import type { Sequelize } from 'sequelize';
import type DiscordCommandHandler from '../commands/discord/DiscordCommandHandler';
import { SyncDiscordCommandHandler } from '../guild-sync/commandHandler';
import type { LinkedGuild } from '../guild-sync/cycle';
import { PostgresGuildSyncStore } from '../guild-sync/store';
import type { AddonConfig } from './config';

/** Builds a command handler once upstream has created the Discord client. */
export type DiscordCommandFactory = (client: Client) => DiscordCommandHandler;

export interface AddonCommandDeps {
    readonly sequelize: Sequelize;
    readonly findGuildLink: (
        discordGuildId: string
    ) => Promise<LinkedGuild | null>;
    readonly discordOwnerId: string | null;
    readonly isChannelLinked: (discordChannelId: string) => Promise<boolean>;
}

/**
 * Extra Discord commands the enabled add-ons need, by command name.
 * Empty when add-ons are off, so upstream's command list is unchanged.
 */
export function addonDiscordCommands(
    config: AddonConfig,
    deps: AddonCommandDeps
): Readonly<Record<string, DiscordCommandFactory>> {
    if (!config.guildSync) return {};
    const store = new PostgresGuildSyncStore(deps.sequelize);
    return {
        sync: (client) =>
            new SyncDiscordCommandHandler(client, {
                store,
                findLink: deps.findGuildLink,
                allowApply: config.allowApply,
                ownerId: deps.discordOwnerId,
                isChannelLinked: deps.isChannelLinked,
                now: () => new Date(),
            }),
    };
}

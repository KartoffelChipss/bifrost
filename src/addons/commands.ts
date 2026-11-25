import { EmbedBuilder, type Client } from 'discord.js';
import type { Sequelize } from 'sequelize';
import DiscordCommandHandler, {
    type DiscordCommandHandlerMessage,
} from '../commands/discord/DiscordCommandHandler';
import { SyncDiscordCommandHandler } from '../guild-sync/commandHandler';
import type { LinkedGuild } from '../guild-sync/cycle';
import { PostgresHistoryStore } from '../history/store';
import { PostgresGuildSyncStore } from '../guild-sync/store';
import { EmbedColors } from '../utils/embeds';
import type { AddonConfig } from './config';
import type { AddonDatabaseState } from './db/migrator';
import { addonDatabaseState } from './state';

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

export const ADDONS_OFF_REPLY =
    'Add-ons are off because their database migrations failed. The relay keeps running; check the logs and restart.';

/** The `sync` command while the add-ons are off: it says so. */
export class AddonsOffCommandHandler extends DiscordCommandHandler {
    async handleCommand(message: DiscordCommandHandlerMessage): Promise<void> {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Guild sync')
                    .setDescription(ADDONS_OFF_REPLY)
                    .setColor(EmbedColors.Error)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }
}

/**
 * Extra Discord commands the enabled add-ons need, by command name.
 * Empty when add-ons are off, so upstream's command list is unchanged.
 */
export function addonDiscordCommands(
    config: AddonConfig,
    deps: AddonCommandDeps,
    databaseState: AddonDatabaseState | null = addonDatabaseState()
): Readonly<Record<string, DiscordCommandFactory>> {
    if (!config.guildSync) return {};
    // Admins still get an answer, not "Unknown command".
    if (databaseState === 'failed') {
        return { sync: (client) => new AddonsOffCommandHandler(client) };
    }
    const store = new PostgresGuildSyncStore(deps.sequelize);
    const history = new PostgresHistoryStore(deps.sequelize);
    return {
        sync: (client) =>
            new SyncDiscordCommandHandler(client, {
                store,
                findLink: deps.findGuildLink,
                allowApply: config.allowApply,
                ownerId: deps.discordOwnerId,
                isChannelLinked: deps.isChannelLinked,
                retryHistory: config.history
                    ? (linkId, now) => history.retryFailed(linkId, now)
                    : undefined,
                now: () => new Date(),
            }),
    };
}

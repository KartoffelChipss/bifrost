import { EmbedBuilder, type Client } from 'discord.js';
import DiscordCommandHandler, {
    type DiscordCommandHandlerMessage,
} from '../commands/discord/DiscordCommandHandler';
import { EmbedColors } from '../utils/embeds';
import {
    describeStatus,
    parseSyncCommand,
    runSyncCommand,
    type SyncCommandContext,
} from './command';
import type { LinkedGuild } from './cycle';
import type { GuildSyncStore } from './store';

/**
 * The `sync` command: the admin switch for guild-sync. It only changes
 * `addon_settings`; the next cycle reads the new values.
 */

export interface SyncCommandDeps extends SyncCommandContext {
    readonly store: SyncCommandContext['store'] &
        Pick<GuildSyncStore, 'lastPlan'>;
    readonly findLink: (discordGuildId: string) => Promise<LinkedGuild | null>;
    readonly allowApply: boolean;
    /** BF_DISCORD_OWNER_ID. The server owner may always run the command. */
    readonly ownerId: string | null;
}

export class SyncDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly deps: SyncCommandDeps
    ) {
        super(client);
    }

    private reply(
        message: DiscordCommandHandlerMessage,
        text: string,
        color: number
    ) {
        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Guild sync')
                    .setDescription(text)
                    .setColor(color)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    private allowed(message: DiscordCommandHandlerMessage): boolean {
        const author = message.author.id;
        return (
            message.guild?.ownerId === author ||
            (this.deps.ownerId !== null && this.deps.ownerId === author)
        );
    }

    async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.guildId || !this.allowed(message)) {
            await this.reply(
                message,
                'Only the server owner can use this command.',
                EmbedColors.Error
            );
            return;
        }
        const command = parseSyncCommand(args);
        if (command.type === 'error') {
            await this.reply(message, command.message, EmbedColors.Error);
            return;
        }
        const link = await this.deps.findLink(message.guildId);
        if (!link) {
            await this.reply(
                message,
                'This server is not linked to a Fluxer server.',
                EmbedColors.Error
            );
            return;
        }
        const error = await runSyncCommand(
            command,
            link,
            message.channelId,
            this.deps
        );
        if (typeof error === 'string') {
            await this.reply(message, error, EmbedColors.Error);
            return;
        }
        const { store, allowApply } = this.deps;
        const status = describeStatus(
            await store.loadSettings(link.id),
            allowApply,
            await store.lastPlan(link.id)
        );
        const text = error ? `${error.note}\n\n${status}` : status;
        await this.reply(message, text, EmbedColors.Info);
    }
}

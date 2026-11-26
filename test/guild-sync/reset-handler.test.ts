import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { Client } from 'discord.js';
import type { CopiedThread } from '../../src/guild-sync/store';
import { PendingResets } from '../../src/guild-sync/threadReset';
import { DEFAULT_SETTINGS, FakeStore } from './fake-store';
import { mapRow } from './fixtures';
import { LINK } from './harness';

// Upstream's command base class loads src/utils/env.ts, which exits the
// process without tokens. Dummy values let the module load in a test.
process.env.BF_FLUXER_TOKEN ||= 'test-token';
process.env.BF_DISCORD_TOKEN ||= 'test-token';

type HandlerModule = typeof import('../../src/guild-sync/commandHandler');
let handlers: HandlerModule;

const GUILD_OWNER = '300000000000000003';
const BOT_OWNER = '400000000000000004';
const RESET_USER = '200000000000000001';

/** The `sync` handler on a FakeStore, with a recording launcher. */
function handlerSetup(resetUserId: string | null = RESET_USER) {
    const store = new FakeStore();
    store.settings = {
        ...DEFAULT_SETTINGS,
        mode: 'apply',
        adminChannelId: 'admin',
    };
    store.rows = [mapRow('thread', 't1', 'f-t1', { id: 'row-1' })];
    const launched: CopiedThread[][] = [];
    const handler = new handlers.SyncDiscordCommandHandler({} as Client, {
        store,
        findLink: async () => LINK,
        allowApply: true,
        ownerId: BOT_OWNER,
        isChannelLinked: async () => false,
        threadReset: {
            pending: new PendingResets(),
            launcher: {
                start: (_link, targets) => {
                    launched.push([...targets]);
                    return 'started';
                },
            },
            allowApply: true,
            userId: resetUserId,
        },
        now: () => new Date('2026-11-25T12:00:00Z'),
    });
    /** Sends `sync <args>` as `author` and returns the reply text. */
    const send = async (author: string, ...args: string[]) => {
        const replies: string[] = [];
        const message = {
            guildId: 'guild',
            guild: { ownerId: GUILD_OWNER },
            channelId: 'admin',
            content: `!b sync ${args.join(' ')}`,
            author: { id: author, username: 'u', displayAvatarURL: () => '' },
            reply: async (options: { embeds: { data: object }[] }) => {
                const data = options.embeds[0].data as { description: string };
                replies.push(data.description);
            },
        };
        await handler.handleCommand(message as never, 'sync', ...args);
        return replies.join('\n');
    };
    return { store, launched, send };
}

describe('SyncDiscordCommandHandler reset-threads', () => {
    before(async () => {
        handlers = await import('../../src/guild-sync/commandHandler');
    });

    it('is off without a configured user, even for the owner', async () => {
        const h = handlerSetup(null);
        assert.match(await h.send(GUILD_OWNER, 'reset-threads'), /not set up/);
        assert.match(await h.send(RESET_USER, 'reset-threads'), /not set up/);
        assert.deepEqual(h.launched, []);
    });

    it('refuses the guild owner and BF_DISCORD_OWNER_ID', async () => {
        const h = handlerSetup();
        for (const author of [GUILD_OWNER, BOT_OWNER]) {
            assert.match(
                await h.send(author, 'reset-threads'),
                /Only the user named/
            );
            assert.match(
                await h.send(author, 'reset-threads', 'confirm'),
                /Only the user named/
            );
        }
        assert.deepEqual(h.launched, []);
    });

    it('runs the reset for the configured user after a preview', async () => {
        const h = handlerSetup();
        assert.match(await h.send(RESET_USER, 'reset-threads'), /preview/);
        assert.match(
            await h.send(RESET_USER, 'reset-threads', 'confirm'),
            /Resetting 1 thread/
        );
        assert.deepEqual(
            h.launched.map((set) => set.map((t) => t.discordId)),
            [['t1']]
        );
    });

    it('keeps the owner rule for every other subcommand', async () => {
        const h = handlerSetup();
        assert.match(await h.send(RESET_USER, 'status'), /server owner/);
        assert.match(await h.send(GUILD_OWNER, 'status'), /Mode: \*\*apply/);
        assert.match(await h.send(BOT_OWNER, 'status'), /Mode: \*\*apply/);
    });
});

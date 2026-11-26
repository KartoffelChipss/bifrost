import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import type { ApplyResult } from '../../src/guild-sync/apply';
import { discordStatusMessenger } from '../../src/guild-sync/notifier';
import { EMPTY_BODY, type Plan } from '../../src/guild-sync/plan';
import type { StatusEmbed } from '../../src/guild-sync/status';
import {
    STATUS_INTERVAL_MS,
    STATUS_REFRESH_MS,
    StatusBoard,
    type StatusMessenger,
    type StatusTimers,
} from '../../src/guild-sync/statusBoard';
import { createRecordingLogger } from '../addons/fakes';
import { DEFAULT_SETTINGS, FakeStore } from './fake-store';

const LINK = 'link-1';
const START = Date.parse('2026-11-25T12:00:00Z');

/** Manual timers: tests move the clock and fire what is due. */
class ManualTimers implements StatusTimers {
    now = START;
    private seq = 0;
    private readonly pending = new Map<
        number,
        { at: number; fn: () => void }
    >();

    setTimeout(fn: () => void, ms: number) {
        this.pending.set(++this.seq, { at: this.now + ms, fn });
        return this.seq;
    }

    clearTimeout(handle: unknown) {
        this.pending.delete(handle as number);
    }

    get size() {
        return this.pending.size;
    }

    /** Advances time, firing due timers in order. Bounded by `limit`. */
    advance(ms: number, limit = 100) {
        const end = this.now + ms;
        for (let i = 0; i < limit; i++) {
            const due = [...this.pending]
                .filter(([, t]) => t.at <= end)
                .sort(([, a], [, b]) => a.at - b.at)[0];
            if (!due) break;
            const [id, timer] = due;
            this.now = timer.at;
            this.pending.delete(id);
            timer.fn();
        }
        this.now = end;
    }
}

/** Records posts and edits; tests mark messages gone or make edits fail. */
class FakeMessenger implements StatusMessenger {
    readonly posts: { channelId: string; embed: StatusEmbed }[] = [];
    readonly edits: {
        channelId: string;
        messageId: string;
        embed: StatusEmbed;
    }[] = [];
    readonly missing = new Set<string>();
    editError: Error | null = null;
    /** Set to hold edits until the test releases them. */
    hold: Promise<void> | null = null;
    private seq = 0;

    async post(channelId: string, embed: StatusEmbed) {
        this.posts.push({ channelId, embed });
        return `msg-${++this.seq}`;
    }

    async edit(channelId: string, messageId: string, embed: StatusEmbed) {
        if (this.hold) await this.hold;
        if (this.editError) throw this.editError;
        if (this.missing.has(messageId)) return 'missing' as const;
        this.edits.push({ channelId, messageId, embed });
        return 'edited' as const;
    }

    get writes() {
        return this.posts.length + this.edits.length;
    }
}

/** Lets every pending promise chain run. Bounded. */
async function settle() {
    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function setup() {
    const store = new FakeStore();
    store.settings = {
        ...DEFAULT_SETTINGS,
        mode: 'apply',
        adminChannelId: 'admin',
    };
    const timers = new ManualTimers();
    const messenger = new FakeMessenger();
    const logger = createRecordingLogger();
    const deps = {
        store,
        messenger,
        processMode: () => 'dry-run' as const,
        allowApply: true,
        commandPrefix: '!b ',
        now: () => new Date(timers.now),
        logger,
        timers,
    };
    const board = new StatusBoard(deps);
    /** Requests an update and lets it run. */
    const update = async () => {
        board.request(LINK);
        timers.advance(0);
        await settle();
    };
    /** Moves the clock and lets due updates run. */
    const advance = async (ms: number) => {
        timers.advance(ms);
        await settle();
    };
    return { store, timers, messenger, logger, deps, board, update, advance };
}

const plan = (id: string, overrides: Partial<Plan> = {}): Plan => ({
    id,
    guildLinkId: LINK,
    direction: 'discord-to-fluxer',
    status: 'dry-run',
    body: EMPTY_BODY,
    abortReason: null,
    ...overrides,
});

const applied = (overrides: Partial<ApplyResult> = {}): ApplyResult => ({
    applied: 7,
    failed: 0,
    skipped: [],
    failures: [],
    postponed: 0,
    stopped: null,
    ...overrides,
});

describe('StatusBoard: where the message goes', () => {
    it('posts a first message, saves its place, then edits it in place', async () => {
        const s = setup();
        await s.update();
        assert.equal(s.messenger.posts.length, 1);
        assert.equal(s.messenger.posts[0].channelId, 'admin');
        assert.deepEqual(s.store.statusMessage, {
            channelId: 'admin',
            messageId: 'msg-1',
        });
        await s.store.setMode(LINK, 'read-only');
        s.board.request(LINK);
        await s.advance(STATUS_INTERVAL_MS);
        assert.equal(s.messenger.posts.length, 1);
        assert.equal(s.messenger.edits.length, 1);
        assert.equal(s.messenger.edits[0].messageId, 'msg-1');
    });

    it('edits the saved message after a restart instead of posting', async () => {
        const s = setup();
        s.store.statusMessage = { channelId: 'admin', messageId: 'old' };
        await s.update();
        assert.equal(s.messenger.posts.length, 0);
        assert.deepEqual(
            s.messenger.edits.map((e) => e.messageId),
            ['old']
        );
    });

    it('posts a new message when the saved one was deleted', async () => {
        const s = setup();
        s.store.statusMessage = { channelId: 'admin', messageId: 'old' };
        s.messenger.missing.add('old');
        await s.update();
        assert.equal(s.messenger.posts.length, 1);
        assert.deepEqual(s.store.statusMessage, {
            channelId: 'admin',
            messageId: 'msg-1',
        });
    });

    it('posts in the new admin channel when it changed', async () => {
        const s = setup();
        s.store.statusMessage = { channelId: 'old-admin', messageId: 'old' };
        await s.update();
        assert.equal(s.messenger.edits.length, 0);
        assert.equal(s.messenger.posts[0].channelId, 'admin');
        assert.deepEqual(s.store.statusMessage, {
            channelId: 'admin',
            messageId: 'msg-1',
        });
    });

    it('posts nothing while no admin channel is set', async () => {
        const s = setup();
        s.store.settings = { ...s.store.settings, adminChannelId: null };
        await s.update();
        assert.equal(s.messenger.writes, 0);
    });

    it('does not post a duplicate when an edit fails, and warns once', async () => {
        const s = setup();
        s.store.statusMessage = { channelId: 'admin', messageId: 'old' };
        s.messenger.editError = new Error('Missing Permissions');
        await s.update();
        for (let i = 0; i < 3; i++) {
            await s.store.setMode(LINK, i % 2 ? 'apply' : 'dry-run');
            s.board.request(LINK);
            await s.advance(STATUS_INTERVAL_MS);
        }
        assert.equal(s.messenger.posts.length, 0);
        assert.deepEqual(s.store.statusMessage, {
            channelId: 'admin',
            messageId: 'old',
        });
        const warnings = s.logger.entries.filter((e) => e.level === 'warn');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].message, /Missing Permissions/);
    });
});

describe('StatusBoard: throttling', () => {
    it('edits at most once per interval and keeps the latest state', async () => {
        const s = setup();
        await s.update();
        assert.equal(s.messenger.writes, 1);
        // A burst right after the first write: nothing until the interval.
        await s.store.setMode(LINK, 'read-only');
        s.board.request(LINK);
        await s.store.setKillSwitch(LINK, true);
        s.board.request(LINK);
        await s.advance(STATUS_INTERVAL_MS - 1);
        assert.equal(s.messenger.writes, 1);
        // One trailing edit carries the latest state.
        await s.advance(1);
        assert.equal(s.messenger.writes, 2);
        assert.match(s.messenger.edits[0].embed.description, /kill switch on/);
        await s.advance(STATUS_INTERVAL_MS * 3);
        assert.equal(s.messenger.writes, 2);
    });

    it('does not lose a change made while an edit is in flight', async () => {
        const s = setup();
        s.store.statusMessage = { channelId: 'admin', messageId: 'old' };
        let release: () => void = () => {};
        s.messenger.hold = new Promise<void>((resolve) => (release = resolve));
        s.board.request(LINK);
        s.timers.advance(0);
        await settle();
        // The edit is in flight; this change must still reach the message.
        await s.store.setKillSwitch(LINK, true);
        s.board.request(LINK);
        s.messenger.hold = null;
        release();
        await settle();
        assert.equal(s.messenger.edits.length, 1);
        await s.advance(STATUS_INTERVAL_MS);
        assert.equal(s.messenger.edits.length, 2);
        assert.match(s.messenger.edits[1].embed.description, /kill switch on/);
    });

    it('skips an edit that would change nothing but the time, for a while', async () => {
        const s = setup();
        await s.update();
        s.board.request(LINK);
        await s.advance(STATUS_INTERVAL_MS);
        assert.equal(s.messenger.writes, 1);
        await s.advance(STATUS_REFRESH_MS);
        s.board.request(LINK);
        await s.advance(0);
        assert.equal(s.messenger.writes, 2);
    });

    it('clears its timers on stop and updates nothing after', async () => {
        const s = setup();
        await s.update();
        s.board.request(LINK);
        assert.equal(s.timers.size, 1);
        await s.board.stop();
        assert.equal(s.timers.size, 0);
        s.board.request(LINK);
        await s.advance(STATUS_INTERVAL_MS * 2);
        assert.equal(s.messenger.writes, 1);
        assert.equal(s.timers.size, 0);
    });
});

describe('StatusBoard: content', () => {
    it('shows what the last cycle planned and applied', async () => {
        const s = setup();
        const saved = plan('plan-9', {
            body: { ...EMPTY_BODY, deferred: [] },
        });
        await s.store.savePlan(saved);
        s.board.recordCycle(LINK, {
            status: 'planned',
            plan: saved,
            applied: applied({ failed: 1, stopped: 'kill switch is on' }),
            more: false,
        });
        s.timers.advance(0);
        await settle();
        const text = s.messenger.posts[0].embed.description;
        const unix = Math.floor(START / 1000);
        assert.match(text, new RegExp(`plan-9\` \\(dry-run\\), <t:${unix}:R>`));
        assert.match(text, /7 written, 1 failed/);
        assert.match(text, /Stopped early:\*\* kill switch is on/);
    });

    it('counts active mapped objects and shows history totals', async () => {
        const s = setup();
        await s.store.insertMapping({
            guildLinkId: LINK,
            kind: 'role',
            discordId: 'd1',
            fluxerId: 'f1',
            createdBySync: true,
            appliedFields: {},
        });
        const board = new StatusBoard({
            ...s.deps,
            historyTotals: async () => ({
                jobs: 4,
                open: 1,
                failed: 0,
                imported: 90,
                skipped: 2,
            }),
        });
        board.request(LINK);
        s.timers.advance(0);
        await settle();
        const text = s.messenger.posts[0].embed.description;
        assert.match(text, /Mapped:\*\* 1 roles/);
        assert.match(text, /4 jobs: 3 done, 1 open, 0 failed/);
        assert.match(text, /90 copied, 2 skipped/);
    });
});

describe('discordStatusMessenger', () => {
    const embed: StatusEmbed = { title: 't', description: 'd', color: 1 };

    function fakeClient(edit: () => Promise<unknown>) {
        const sent: unknown[] = [];
        const channel = {
            isSendable: () => true,
            send: async (options: unknown) => {
                sent.push(options);
                return { id: 'new-id' };
            },
            messages: { edit },
        };
        const client = {
            channels: { fetch: async () => channel },
        } as unknown as Client;
        return { client, sent };
    }

    it('refuses a bridged admin channel', async () => {
        const { client, sent } = fakeClient(async () => ({}));
        const messenger = discordStatusMessenger(client, async () => true);
        await assert.rejects(messenger.post('admin', embed), /bridged/);
        await assert.rejects(messenger.edit('admin', 'm', embed), /bridged/);
        assert.equal(sent.length, 0);
    });

    it('posts with no mentions allowed and returns the message ID', async () => {
        const { client, sent } = fakeClient(async () => ({}));
        const messenger = discordStatusMessenger(client, async () => false);
        assert.equal(await messenger.post('admin', embed), 'new-id');
        const options = sent[0] as { allowedMentions: unknown };
        assert.deepEqual(options.allowedMentions, { parse: [] });
    });

    it('reports an Unknown Message as missing and rethrows anything else', async () => {
        const unknown = new DiscordAPIError(
            { code: RESTJSONErrorCodes.UnknownMessage, message: 'Unknown' },
            RESTJSONErrorCodes.UnknownMessage,
            404,
            'PATCH',
            '/channels/1/messages/2',
            {}
        );
        const gone = fakeClient(async () => {
            throw unknown;
        });
        const messenger = discordStatusMessenger(
            gone.client,
            async () => false
        );
        assert.equal(await messenger.edit('admin', 'm', embed), 'missing');
        const denied = fakeClient(async () => {
            throw new Error('Missing Permissions');
        });
        await assert.rejects(
            discordStatusMessenger(denied.client, async () => false).edit(
                'admin',
                'm',
                embed
            ),
            /Missing Permissions/
        );
    });
});

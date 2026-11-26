import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MapRow } from '../../src/guild-sync/ops';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import {
    HistoryImporter,
    MAX_FAILURES,
    MAX_GAP_PAGES,
    MAX_SKIP_STREAK,
    RECOVERY_SCAN,
    MAX_PARALLEL,
    PAGE_SIZE,
    PASS_BUDGET_MS,
    RETRY_BASE_MS,
    RETRY_MAX_MS,
    SEND_INTERVAL_MS,
    backoffMs,
    snowflakeTime,
    type HistoryMode,
    type ImporterDeps,
} from '../../src/history/importer';
import { contentHash } from '../../src/history/format';
import { MAX_JOBS } from '../../src/history/store';
import { SURVEY_MAX_PAGES, estimateMinutes } from '../../src/history/survey';
import type { HistoryJob } from '../../src/history/types';
import { createRecordingLogger } from '../addons/fakes';
import { FakeLinker } from '../guild-sync/fake-store';
import { channel, discordGuild, mapRow } from '../guild-sync/fixtures';
import { FakeHistoryPorts, FakeHistoryStore } from './fakes';

const LINK = { id: 'link-1', discordGuildId: '100', fluxerGuildId: '900' };

function source(): GuildSnapshot {
    return discordGuild({
        channels: [
            channel('10', { name: 'general' }),
            channel('20', { type: 15, name: 'game-chat' }),
            channel('30', { type: 2, name: 'voice' }),
        ],
        threads: [
            {
                id: '200',
                parentId: '20',
                name: 'Post',
                archived: true,
                locked: true,
                tags: [],
            },
        ],
    });
}

function setup(
    mode: HistoryMode = 'apply',
    excluded: string[] = [],
    inlineMax?: number
) {
    const store = new FakeHistoryStore();
    const ports = new FakeHistoryPorts();
    const links = new FakeLinker();
    const rows: MapRow[] = [];
    const state = {
        mode,
        snapshot: source() as GuildSnapshot | null,
        clock: Date.parse('2026-11-25T12:00:00Z'),
        clockMoves: true,
        admin: null as string | null,
    };
    const reports: string[] = [];
    const threadEdits: string[] = [];
    const recorded: string[] = [];
    const pauses: number[] = [];
    const importer = new HistoryImporter({
        store,
        sync: {
            lastSnapshot: async () => state.snapshot,
            loadObjectMap: async () => rows,
        },
        ports,
        links,
        excluded: new Set(excluded),
        adminChannel: async () => state.admin,
        inlineMax,
        writer: {
            async updateThread(_guild, id, patch) {
                threadEdits.push(`${id} ${JSON.stringify(patch)}`);
            },
            async createThread(_guild, spec) {
                threadEdits.push(`create ${spec.parentId} ${spec.name}`);
                return `thread-of-${spec.parentId}`;
            },
        },
        recordThreadState: async (linkId, threadId, thread) => {
            recorded.push(`${linkId} ${threadId} ${JSON.stringify(thread)}`);
        },
        commandPrefix: '!b ',
        mode: async () => state.mode,
        report: async (_link, _key, text) => {
            reports.push(text);
        },
        // Sending takes time: the clock moves with every pause.
        pause: async (ms) => {
            pauses.push(ms);
            if (state.clockMoves) state.clock += ms;
        },
        now: () => new Date(state.clock),
        logger: createRecordingLogger(),
    });
    /** Maps a Discord channel or thread to its Fluxer copy. */
    const map = (
        kind: 'channel' | 'thread',
        discordId: string,
        fluxerId: string
    ) => rows.push(mapRow(kind, discordId, fluxerId));
    /** Runs passes until nothing is left, at most `limit`. */
    const drain = async (limit = 30) => {
        for (let i = 0; i < limit; i++) if (!(await importer.run(LINK))) return;
        assert.fail('the import did not finish');
    };
    return {
        store,
        ports,
        links,
        importer,
        state,
        reports,
        threadEdits,
        recorded,
        pauses,
        map,
        drain,
    };
}

describe('history jobs', () => {
    it('makes one job per text or voice channel and per thread, none for forums', async () => {
        const s = setup('dry-run');
        const jobs = await s.importer.planJobs(LINK);
        assert.deepEqual(jobs.map((j) => `${j.kind}:${j.discordId}`).sort(), [
            'channel:10',
            'channel:30',
            'thread:200',
        ]);
    });

    it('makes no job for an excluded channel or the threads inside it', async () => {
        const s = setup('dry-run', ['10', '20', '30']);
        assert.deepEqual(await s.importer.planJobs(LINK), []);
        assert.deepEqual(s.store.jobs, []);
    });

    it('stops running a job made before its channel was excluded', async () => {
        const s = setup('apply', ['10']);
        await s.store.ensureJob(LINK.id, 'channel', '10', null);
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.equal(s.ports.sent.length, 0);
        assert.equal(s.store.job('10').status, 'pending');
    });

    it('does nothing while read-only', async () => {
        const s = setup('read-only');
        assert.equal(await s.importer.run(LINK), false);
        assert.deepEqual(s.store.jobs, []);
    });
});

describe('dry-run survey', () => {
    it('counts messages and attachments, skipping the forum starter and system messages', async () => {
        const s = setup('dry-run');
        s.ports.add('10', '11', { attachments: 2 });
        s.ports.add('10', '12', { copyable: false });
        s.ports.add('200', '200');
        s.ports.add('200', '201');
        s.ports.add('200', '202');
        await s.drain();
        assert.equal(s.store.job('10').messageCount, 1);
        assert.equal(s.store.job('10').attachmentCount, 2);
        assert.equal(s.store.job('200').messageCount, 2);
        assert.deepEqual(s.ports.sent, []);
        assert.match(s.reports[0] ?? '', /Channels: 2, 1 messages/);
        assert.match(s.reports[0] ?? '', /Posts and threads: 1, 2 replies/);
    });

    it('records an unreadable channel and counts the others', async () => {
        const s = setup('dry-run');
        s.ports.add('200', '201');
        const original = s.ports.listMessages.bind(s.ports);
        s.ports.listMessages = async (id, after, limit) => {
            if (id === '10') throw new Error('Missing Access');
            return original(id, after, limit);
        };
        await s.drain();
        assert.equal(s.store.job('200').messageCount, 1);
        assert.match(
            s.reports[0] ?? '',
            /Could not read: channel 10 \(Missing Access\)/
        );
    });

    it('shows a count that hit the page limit as a lower bound', async () => {
        const s = setup('dry-run', ['20', '30']);
        let seq = 1000;
        s.ports.listMessages = async () =>
            Array.from({ length: PAGE_SIZE }, () => ({
                id: String(++seq),
                authorId: 'author',
                createdAt: new Date(0),
                copyable: true,
                attachments: 0,
                webhookId: null,
                ownWebhook: false,
                reply: null,
                reactions: [],
                raw: null,
            }));
        await s.drain();
        const total = SURVEY_MAX_PAGES * PAGE_SIZE;
        assert.match(
            s.reports[0] ?? '',
            new RegExp(`Channels: 1, >= ${total} messages`)
        );
        assert.match(s.reports[0] ?? '', /Estimated run time: at least about/);
    });

    it('counts each job once, and only a new job later', async () => {
        const s = setup('dry-run');
        s.ports.add('10', '11');
        let reads = 0;
        const original = s.ports.listMessages.bind(s.ports);
        s.ports.listMessages = async (id, after, limit) => {
            reads += 1;
            return original(id, after, limit);
        };
        await s.drain();
        const first = reads;
        s.state.clock += 2 * 24 * 60 * 60_000;
        await s.drain();
        assert.equal(reads, first);
        const snapshot = source();
        s.state.snapshot = {
            ...snapshot,
            channels: [...snapshot.channels, channel('40', { name: 'new' })],
        };
        await s.drain();
        assert.equal(reads, first + 1);
    });
});

describe('run-time estimate', () => {
    const job = (
        kind: 'channel' | 'thread',
        messageCount: number,
        parentDiscordId: string | null = null
    ) => ({
        kind,
        messageCount,
        parentDiscordId,
        discordId: String(messageCount),
    });

    it('takes the longest webhook queue: one parent shares a webhook across its threads', () => {
        const jobs = [
            job('channel', 100),
            job('thread', 150, '20'),
            job('thread', 150, '20'),
        ] as unknown as HistoryJob[];
        // 300 replies through one webhook outlast the channel and 400 / 4.
        assert.equal(
            estimateMinutes(jobs),
            Math.ceil((300 * SEND_INTERVAL_MS) / 60_000)
        );
    });

    it('spreads many small channels over the parallel slots', () => {
        const jobs = Array.from({ length: 8 }, () =>
            job('channel', 100)
        ) as unknown as HistoryJob[];
        assert.equal(
            estimateMinutes(jobs),
            Math.ceil(((800 / MAX_PARALLEL) * SEND_INTERVAL_MS) / 60_000)
        );
    });
});

describe('copying a channel', () => {
    it('copies oldest first with the original time, then waits for the bridge', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.add('10', '12', { authorId: 'shy' });
        s.ports.add('10', '13', { copyable: false });
        s.store.optOuts.add('shy');
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => [m.webhook, m.content.split('\n')[0]]),
            [
                ['import-f10', 'message 11'],
                [
                    'import-f10',
                    '*A message from a member who opted out of history import.*',
                ],
            ]
        );
        assert.match(
            s.ports.sent[0].content,
            /Originally posted 2024-03-01 18:22 UTC/
        );
        assert.equal(s.store.job('10').status, 'ready');
        assert.deepEqual(s.pauses, [SEND_INTERVAL_MS, SEND_INTERVAL_MS]);
        assert.ok(s.store.messages.every((m) => m.fluxerMessageId));
    });

    it('catches up on messages posted while it ran', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.importer.run(LINK);
        s.ports.add('10', '14');
        await s.drain();
        assert.equal(s.ports.sent.length, 2);
        assert.equal(s.store.job('10').status, 'ready');
    });

    it('closes the gap through the bridge, up to the first relayed message', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.drain();
        s.ports.add('10', '15');
        s.ports.add('10', '16');
        s.ports.relayed.add('16');
        await s.links.link(LINK.id, '10', 'f10');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.webhook),
            ['import-f10', 'fw-f10']
        );
        assert.equal(s.store.job('10').status, 'done');
    });

    it('pages through more than one page', async () => {
        const s = setup();
        for (let i = 0; i < PAGE_SIZE + 5; i++)
            s.ports.add('10', String(1000 + i));
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.equal(s.ports.sent.length, PAGE_SIZE + 5);
    });
});

describe('copying a forum post', () => {
    it('waits for the forum bridge, opens the post, copies replies and restores its state', async () => {
        const s = setup();
        s.ports.add('200', '200');
        s.ports.add('200', '201');
        s.ports.threadStates.set('200', { archived: true, locked: true });
        s.map('thread', '200', 'f200');
        await s.drain();
        assert.equal(s.ports.sent.length, 0);
        await s.links.link(LINK.id, '20', 'f20');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => [m.webhook, m.threadId]),
            [['fw-f20', 'f200']]
        );
        // Unlocked only while the page is sent, then locked again; an
        // archived thread is never opened, as a webhook post reopens it.
        assert.deepEqual(s.threadEdits, [
            'f200 {"locked":false}',
            'f200 {"locked":true}',
            'f200 {"archived":true,"locked":true}',
        ]);
        assert.equal(s.store.job('200').status, 'done');
        assert.equal(await s.store.threadImporting('f200'), false);
        assert.deepEqual(s.recorded, [
            'link-1 200 {"archived":true,"locked":true}',
        ]);
    });

    it('skips replies the thread relay copied live and bridge copies of Fluxer replies', async () => {
        const s = setup();
        s.ports.add('200', '200');
        s.ports.add('200', '201');
        s.ports.add('200', '202');
        s.ports.add('200', '203', { webhookId: 'dw-20' });
        s.ports.add('200', '204');
        s.store.relayedThread.add('202');
        s.map('thread', '200', 'f200');
        await s.links.link(LINK.id, '20', 'f20');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.content.split('\n')[0]),
            ['message 201', 'message 204']
        );
        assert.equal(s.store.job('200').checkpointId, '204');
    });
});

describe('thread lock window', () => {
    it('never unlocks a thread that is open on Discord, and re-locks after a failed page', async () => {
        const s = setup();
        s.ports.add('200', '201');
        s.map('thread', '200', 'f200');
        await s.links.link(LINK.id, '20', 'f20');
        s.ports.threadStates.set('200', { archived: true, locked: false });
        await s.drain();
        assert.deepEqual(s.threadEdits, [
            'f200 {"archived":true,"locked":false}',
        ]);

        const t = setup();
        t.ports.add('200', '201');
        t.map('thread', '200', 'f200');
        await t.links.link(LINK.id, '20', 'f20');
        t.ports.threadStates.set('200', { archived: false, locked: true });
        t.ports.failNext = 1;
        await t.importer.run(LINK);
        assert.deepEqual(t.threadEdits, [
            'f200 {"locked":false}',
            'f200 {"locked":true}',
        ]);
    });
});

describe('earlier relay copies', () => {
    it('skips posts by an earlier bridge webhook or one this app owns', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.add('10', '12', { webhookId: 'old-bridge' });
        s.ports.add('10', '13', { webhookId: 'gone-hook', ownWebhook: true });
        s.ports.add('10', '14', { webhookId: 'someone-elses-hook' });
        s.ports.bridgeHooks.set('10', ['old-bridge']);
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.content.split('\n')[0]),
            ['message 11', 'message 14']
        );
    });
});

describe('archive-thread mode', () => {
    const big = (s: ReturnType<typeof setup>, channelId: string) => {
        for (let i = 0; i < 3; i++) s.ports.add(channelId, String(11 + i));
    };

    it('is off by default: a big channel imports inline and bridges after', async () => {
        const s = setup('apply', ['20', '30']);
        big(s, '10');
        s.map('channel', '10', 'f10');
        await s.importer.planJobs(LINK);
        s.state.clockMoves = false;
        await s.importer.run(LINK);
        assert.ok(!s.threadEdits.some((e) => e.startsWith('create')));
        assert.ok(s.ports.sent.every((m) => m.threadId === null));
        await s.drain();
        assert.deepEqual(
            await s.store.channelsReadyToBridge(LINK.id),
            new Set(['10'])
        );
    });

    it('sends a channel above the limit to a locked thread and bridges it at once', async () => {
        const s = setup('apply', ['20', '30'], 2);
        big(s, '10');
        s.map('channel', '10', 'f10');
        const sendCopy = s.ports.sendCopy.bind(s.ports);
        let checked = false;
        s.ports.sendCopy = async (target, payload) => {
            if (!checked) {
                checked = true;
                // Ready to bridge before the first copy is sent.
                assert.deepEqual(
                    await s.store.channelsReadyToBridge(LINK.id),
                    new Set(['10'])
                );
            }
            return sendCopy(target, payload);
        };
        await s.importer.run(LINK);
        assert.equal(s.store.job('10').archiveThreadId, 'thread-of-f10');
        assert.equal(await s.store.isArchiveThread('thread-of-f10'), true);
        // Linked mid-import: the history still goes to the thread.
        await s.links.link(LINK.id, '10', 'f10');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => [m.webhook, m.threadId]),
            [
                ['import-f10', 'thread-of-f10'],
                ['import-f10', 'thread-of-f10'],
                ['import-f10', 'thread-of-f10'],
            ]
        );
        assert.equal(s.threadEdits[0], 'create f10 History before 2026-11-25');
        assert.equal(s.threadEdits[1], 'thread-of-f10 {"locked":true}');
        assert.equal(
            s.threadEdits[s.threadEdits.length - 1],
            'thread-of-f10 {"archived":true,"locked":true}'
        );
        assert.equal(s.store.job('10').status, 'done');
        assert.ok(s.store.messages.every((m) => m.inThread));
    });

    it('stops the archive at the link, leaving newer messages to the relay', async () => {
        const s = setup('apply', ['20', '30'], 2);
        big(s, '10');
        const linkedAt = Date.parse('2026-11-25T11:00:00Z');
        const live = (
            BigInt(linkedAt + 1_000 - 1_420_070_400_000) << BigInt(22)
        ).toString();
        s.map('channel', '10', 'f10');
        const sendCopy = s.ports.sendCopy.bind(s.ports);
        s.ports.sendCopy = async (target, payload) => {
            const id = await sendCopy(target, payload);
            if (!(await s.links.byDiscordChannel('10'))) {
                // Bridged after the first copy; a live message follows.
                await s.links.link(LINK.id, '10', 'f10');
                s.ports.linkTimes.set('10', new Date(linkedAt));
                s.ports.add('10', live);
            }
            return id;
        };
        await s.drain();
        assert.equal(s.ports.sent.length, 3);
        assert.equal(await s.store.importedByDiscordId(live), null);
    });

    it('keeps a voice channel inline above the limit', async () => {
        const s = setup('apply', ['10', '20'], 2);
        big(s, '30');
        s.map('channel', '30', 'f30');
        await s.drain();
        assert.equal(s.store.job('30').archiveThreadId, null);
        assert.ok(s.ports.sent.every((m) => m.threadId === null));
        assert.equal(s.store.job('30').status, 'ready');
    });

    it('imports inline when the thread cannot be made', async () => {
        const s = setup('apply', ['20', '30'], 2);
        big(s, '10');
        s.map('channel', '10', 'f10');
        const importer = new HistoryImporter({
            ...(s.importer as unknown as { deps: ImporterDeps }).deps,
            writer: {
                updateThread: async () => {},
                createThread: async () => {
                    throw new Error('Missing Permissions');
                },
            },
        });
        await importer.run(LINK);
        assert.equal(s.store.job('10').archiveThreadId, null);
        assert.ok(s.ports.sent.every((m) => m.threadId === null));
    });
});

describe('threadImporting', () => {
    it('counts a pending job whose Fluxer thread is not filled in yet, when the pair names it', async () => {
        const s = setup('dry-run');
        await s.importer.planJobs(LINK);
        assert.equal(s.store.job('200').fluxerId, null);
        assert.equal(await s.store.threadImporting('f200'), false);
        s.store.threadPairs.set('f200', '200');
        assert.equal(await s.store.threadImporting('f200'), true);
        await s.store.updateJob(s.store.job('200').id, { status: 'done' });
        assert.equal(await s.store.threadImporting('f200'), false);
    });
});

describe('failures and recovery', () => {
    it('retries a refused upload without its files', async () => {
        const s = setup();
        s.ports.add('10', '11', { raw: { text: 'pic', files: 1 } });
        s.ports.refuseFiles = true;
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.equal(s.ports.sent[0].files, 0);
        assert.deepEqual(s.ports.sent[0].content.split('\n').slice(1), [
            '*Attachments not copied: file0.png*',
            '*Originally posted 2024-03-01 18:22 UTC*',
        ]);
    });

    it('keeps the files and the unfinished record after a temporary error', async () => {
        const s = setup();
        s.ports.add('10', '11', { raw: { id: '11', text: 'pic', files: 1 } });
        s.map('channel', '10', 'f10');
        s.ports.failNext = 1;
        await s.importer.run(LINK);
        assert.equal(s.store.messages.length, 1);
        assert.equal(s.store.messages[0].fluxerMessageId, null);
        s.state.clock += RETRY_MAX_MS;
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.files),
            [1]
        );
    });

    it('does not resend a copy that went through before a timeout', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        const original = s.ports.sendCopy.bind(s.ports);
        let calls = 0;
        s.ports.sendCopy = async (target, payload) => {
            calls += 1;
            if (calls > 1) return original(target, payload);
            s.ports.recentCopies = [
                {
                    id: 'posted',
                    webhookId: target.webhook.id,
                    content: payload.content,
                },
            ];
            throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        };
        await s.importer.run(LINK);
        s.state.clock += RETRY_MAX_MS;
        await s.drain();
        assert.equal(calls, 1);
        assert.equal(s.store.messages[0].fluxerMessageId, 'posted');
    });

    it('waits out a temporary error with backoff and never fails the job for it', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        s.ports.failNext = MAX_FAILURES * 2;
        for (let i = 0; i < MAX_FAILURES * 2; i++) {
            await s.importer.run(LINK);
            const job = s.store.job('10');
            assert.equal(job.status, 'importing');
            assert.equal(job.failures, 0);
            assert.equal(job.retries, i + 1);
            // Before the backoff ends, a pass leaves the job alone.
            assert.equal(await s.importer.waiting(LINK.id), true);
            await s.importer.run(LINK);
            assert.equal(s.store.job('10').retries, i + 1);
            s.state.clock += backoffMs(i + 1);
        }
        await s.drain();
        assert.equal(s.ports.sent.length, 1);
        assert.equal(s.store.job('10').retries, 0);
        assert.equal(s.store.job('10').retryAt, null);
    });

    it('doubles the wait per error in a row, up to a cap', () => {
        assert.equal(backoffMs(1), RETRY_BASE_MS);
        assert.equal(backoffMs(2), RETRY_BASE_MS * 2);
        assert.equal(backoffMs(1000), RETRY_MAX_MS);
    });

    it('skips and records a message that keeps failing, then copies on', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.add('10', '12');
        s.map('channel', '10', 'f10');
        s.ports.failure = Object.assign(new Error('Invalid Form Body'), {
            statusCode: 400,
        });
        s.ports.failNext = MAX_FAILURES;
        for (let i = 0; i < MAX_FAILURES; i++) {
            await s.importer.run(LINK);
            s.state.clock += RETRY_MAX_MS;
        }
        assert.equal(s.store.job('10').skipped, 1);
        assert.match(s.store.job('10').lastError ?? '', /skipped message 11/);
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.content.split('\n')[0]),
            ['message 12']
        );
        assert.equal(s.store.job('10').status, 'ready');
        assert.deepEqual(
            s.store.messages.map((m) => m.discordMessageId),
            ['12']
        );
    });

    it('fails a job whose channel keeps refusing reads, and an admin can retry it', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        const original = s.ports.listMessages.bind(s.ports);
        let refuse = true;
        s.ports.listMessages = async (id, after, limit) => {
            if (refuse && id === '10')
                throw Object.assign(new Error('Missing Access'), {
                    status: 403,
                });
            return original(id, after, limit);
        };
        for (let i = 0; i < MAX_FAILURES; i++) {
            await s.importer.run(LINK);
            s.state.clock += RETRY_MAX_MS;
        }
        assert.equal(s.store.job('10').status, 'failed');
        assert.deepEqual(
            await s.store.channelsReadyToBridge(LINK.id),
            new Set()
        );
        refuse = false;
        assert.equal(await s.store.retryFailed(LINK.id), 1);
        assert.equal(s.store.job('10').status, 'importing');
        await s.drain();
        assert.equal(s.ports.sent.length, 1);
        assert.deepEqual(
            await s.store.channelsReadyToBridge(LINK.id),
            new Set(['10'])
        );
    });

    it('reports skipped messages in the summary', async () => {
        const s = setup('apply', ['20', '30']);
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        s.ports.failure = Object.assign(new Error('bad'), { statusCode: 400 });
        s.ports.failNext = MAX_FAILURES;
        for (let i = 0; i < MAX_FAILURES; i++) {
            await s.importer.run(LINK);
            s.state.clock += RETRY_MAX_MS;
        }
        await s.links.link(LINK.id, '10', 'f10');
        await s.drain();
        assert.match(
            s.reports.join('\n'),
            /0 messages copied, 1 messages skipped, 0 jobs failed/
        );
    });

    it('records a copy that was sent before a crash instead of sending it twice', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.importer.planJobs(LINK);
        const job = s.store.job('10');
        await s.store.updateJob(job.id, {
            status: 'importing',
            cutoffId: '11',
            importWebhook: { id: 'import-f10', token: 'secret' },
        });
        await s.store.startMessage({
            discordMessageId: '11',
            jobId: job.id,
            discordAuthorId: 'author',
            fluxerMessageId: null,
            fluxerTargetId: 'f10',
            inThread: false,
            webhookId: 'import-f10',
        });
        s.ports.recentCopies = [
            { id: 'already-sent', webhookId: 'import-f10', content: '' },
        ];
        await s.store.updateJob(job.id, { checkpointId: '11' });
        await s.drain();
        assert.deepEqual(s.ports.sent, []);
        assert.equal(s.store.messages[0]?.fluxerMessageId, 'already-sent');
    });

    it('stops between messages when apply is switched off', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.add('10', '12');
        s.map('channel', '10', 'f10');
        let calls = 0;
        const original = s.ports.sendCopy.bind(s.ports);
        s.ports.sendCopy = async (target, payload) => {
            calls += 1;
            s.state.mode = 'dry-run';
            return original(target, payload);
        };
        await s.importer.run(LINK);
        assert.equal(calls, 1);
        assert.equal(s.store.job('10').failures, 0);
    });
});

describe('restarts', () => {
    async function crashedAfterSend(finished: boolean) {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.add('10', '12');
        s.map('channel', '10', 'f10');
        await s.importer.planJobs(LINK);
        const job = s.store.job('10');
        await s.store.updateJob(job.id, {
            status: 'importing',
            cutoffId: '12',
            importWebhook: { id: 'import-f10', token: 'secret' },
        });
        await s.store.startMessage({
            discordMessageId: '11',
            jobId: job.id,
            discordAuthorId: 'author',
            fluxerMessageId: finished ? 'already-sent' : null,
            fluxerTargetId: 'f10',
            inThread: false,
            webhookId: 'import-f10',
        });
        return s;
    }

    it('moves past a copy recorded before the checkpoint was saved', async () => {
        const s = await crashedAfterSend(true);
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.content.split('\n')[0]),
            ['message 12']
        );
        assert.equal(s.store.job('10').failures, 0);
        assert.equal(s.store.job('10').status, 'ready');
    });

    it('resolves a copy cut off mid-send before copying on', async () => {
        const s = await crashedAfterSend(false);
        s.ports.recentCopies = [
            { id: 'already-sent', webhookId: 'import-f10', content: '' },
        ];
        await s.drain();
        assert.equal(s.ports.sent.length, 1);
        assert.equal(s.store.messages[0]?.fluxerMessageId, 'already-sent');

        const t = await crashedAfterSend(false);
        t.ports.recentCopies = [
            { id: 'live', webhookId: 'someone-else', content: '' },
        ];
        await t.drain();
        assert.equal(t.ports.sent.length, 2);
        assert.equal(t.store.job('10').failures, 0);
    });
});

describe('crash recovery', () => {
    /** A gap-pass copy of message 15 cut off mid-send, with its hash. */
    async function cutOff(content: string) {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.drain();
        s.ports.add('10', '15');
        await s.links.link(LINK.id, '10', 'f10');
        const job = s.store.job('10');
        await s.store.startMessage({
            discordMessageId: '15',
            jobId: job.id,
            discordAuthorId: 'author',
            fluxerMessageId: null,
            fluxerTargetId: 'f10',
            inThread: false,
            webhookId: 'fw-f10',
            contentHash: contentHash(content),
        });
        return s;
    }

    it('skips newer live relay posts by the same webhook and finds the copy by its text', async () => {
        const s = await cutOff('the copy');
        s.ports.relayedFluxer.add('live-2');
        s.ports.recentCopies = [
            { id: 'live-2', webhookId: 'fw-f10', content: 'the copy' },
            { id: 'live-1', webhookId: 'fw-f10', content: 'chat' },
            { id: 'ours', webhookId: 'fw-f10', content: 'the copy\n' },
        ];
        await s.drain();
        assert.equal(
            (await s.store.importedByDiscordId('15'))?.fluxerMessageId,
            'ours'
        );
        assert.equal(s.ports.sent.length, 1);
    });

    it('treats the copy as not sent when no recent text matches', async () => {
        const s = await cutOff('the copy');
        s.ports.recentCopies = [
            { id: 'live-1', webhookId: 'fw-f10', content: 'chat' },
        ];
        await s.drain();
        assert.equal(
            (await s.store.importedByDiscordId('15'))?.fluxerMessageId,
            'copy-2'
        );
        assert.equal(s.ports.sent.length, 2);
    });
});

describe('bridging during an import', () => {
    it('hands a channel linked mid-page to the gap pass, never sending through the import webhook again', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.add('10', '12');
        s.ports.add('10', '13');
        s.map('channel', '10', 'f10');
        const original = s.ports.sendCopy.bind(s.ports);
        s.ports.sendCopy = async (target, payload) => {
            const id = await original(target, payload);
            if (!(await s.links.byDiscordChannel('10')))
                await s.links.link(LINK.id, '10', 'f10');
            return id;
        };
        await s.importer.run(LINK);
        assert.equal(s.store.job('10').status, 'ready');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.webhook),
            ['import-f10', 'fw-f10', 'fw-f10']
        );
        assert.equal(s.store.job('10').status, 'done');
    });

    it('hands over a channel linked between passes instead of failing it', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.add('10', '12');
        s.map('channel', '10', 'f10');
        const original = s.ports.sendCopy.bind(s.ports);
        let calls = 0;
        s.ports.sendCopy = async (target, payload) => {
            calls += 1;
            // Writes stop after the first copy, as at the end of a pass.
            if (calls === 1) s.state.mode = 'dry-run';
            return original(target, payload);
        };
        await s.importer.run(LINK);
        s.state.mode = 'apply';
        await s.links.link(LINK.id, '10', 'f10');
        await s.drain();
        assert.equal(s.store.job('10').status, 'done');
        assert.deepEqual(
            s.ports.sent.map((m) => m.webhook),
            ['import-f10', 'fw-f10']
        );
    });

    /** A Discord snowflake made at `ms` since the Unix epoch. */
    const snowflakeAt = (ms: number) =>
        (BigInt(ms - 1_420_070_400_000) << BigInt(22)).toString();

    it('copies only gap messages older than the link, leaving newer ones to the relay', async () => {
        const s = setup();
        s.map('channel', '10', 'f10');
        await s.drain();
        const linkedAt = Date.parse('2026-11-25T11:00:00Z');
        const before = snowflakeAt(linkedAt - 1_000);
        const after = snowflakeAt(linkedAt + 1_000);
        assert.ok(snowflakeTime(before) < linkedAt);
        s.ports.add('10', before);
        s.ports.add('10', after);
        await s.links.link(LINK.id, '10', 'f10');
        s.ports.linkTimes.set('10', new Date(linkedAt));
        await s.drain();
        assert.equal(s.ports.sent.length, 1);
        assert.equal(await s.store.importedByDiscordId(after), null);
        assert.equal(s.store.job('10').status, 'done');
    });

    it('never runs a gap pass and a thread of the same parent at once', async () => {
        const s = setup();
        s.state.snapshot = discordGuild({
            channels: [channel('10', { name: 'general' })],
            threads: [
                {
                    id: '400',
                    parentId: '10',
                    name: 'T',
                    archived: false,
                    locked: false,
                    tags: [],
                },
            ],
        });
        s.map('channel', '10', 'f10');
        s.map('thread', '400', 'f400');
        await s.drain();
        s.ports.add('10', '15');
        s.ports.add('400', '401');
        await s.links.link(LINK.id, '10', 'f10');
        let active = 0;
        let most = 0;
        const original = s.ports.sendCopy.bind(s.ports);
        s.ports.sendCopy = async (target, payload) => {
            active += 1;
            most = Math.max(most, active);
            await new Promise((resolve) => setImmediate(resolve));
            active -= 1;
            return original(target, payload);
        };
        await s.drain();
        assert.equal(s.ports.sent.length, 2);
        assert.equal(most, 1);
    });

    it('polls soon while a copied channel waits for its bridge', async () => {
        const s = setup('apply', ['20', '30']);
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.equal(s.store.job('10').status, 'ready');
        assert.equal(await s.importer.waiting(LINK.id), true);
    });

    it('keeps closing a long gap in later passes', async () => {
        const s = setup();
        s.state.clockMoves = false;
        s.map('channel', '10', 'f10');
        await s.drain();
        const gap = MAX_GAP_PAGES * PAGE_SIZE + 3;
        for (let i = 0; i < gap; i++) s.ports.add('10', String(1000 + i));
        await s.links.link(LINK.id, '10', 'f10');
        assert.equal(await s.importer.run(LINK), true);
        assert.equal(s.store.job('10').status, 'ready');
        assert.equal(s.ports.sent.length, MAX_GAP_PAGES * PAGE_SIZE);
        await s.drain();
        assert.equal(s.ports.sent.length, gap);
        assert.equal(s.store.job('10').status, 'done');
    });
});

describe('voice channels', () => {
    it('copies a voice channel and waits for its bridge, like text', async () => {
        const s = setup();
        s.ports.add('30', '31');
        s.map('channel', '30', 'f30');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.webhook),
            ['import-f30']
        );
        assert.equal(s.store.job('30').status, 'ready');
    });
});

describe('copy content', () => {
    it('leaves out the quote of a reply to an opted-out or unknown author', async () => {
        const s = setup();
        s.ports.add('10', '11', { reply: { authorId: 'friend' } });
        s.ports.add('10', '12', { reply: { authorId: 'shy' } });
        s.ports.add('10', '13', { reply: { authorId: null } });
        s.ports.add('10', '14');
        s.store.optOuts.add('shy');
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.deepEqual(
            s.ports.payloadOptions.map((o) => o.withoutReply),
            [false, true, true, false]
        );
    });

    it('keeps a copy from running a Fluxer command', async () => {
        const s = setup();
        s.ports.add('10', '11', { raw: { id: '11', text: '!b help' } });
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.ok(s.ports.sent[0].content.startsWith('\u200b!b help'));
    });

    it('breaks @everyone and @here so a copy never pings', async () => {
        const s = setup();
        s.ports.add('10', '11', {
            raw: { id: '11', text: '@everyone and @here look' },
        });
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.equal(
            s.ports.sent[0].content.split('\n')[0],
            '@\u200beveryone and @\u200bhere look'
        );
    });

    it('cuts a long message to the Fluxer limit and keeps the date note', async () => {
        const s = setup();
        s.ports.add('10', '11', {
            raw: { id: '11', text: 'y'.repeat(4500) },
            reactions: [{ name: '👍', count: 2 }],
        });
        s.map('channel', '10', 'f10');
        await s.drain();
        const lines = s.ports.sent[0].content.split('\n');
        assert.ok(s.ports.sent[0].content.length <= 4000);
        assert.ok(lines[0].endsWith('…'));
        assert.deepEqual(lines.slice(1), [
            'Reactions: 👍 2',
            '*Originally posted 2024-03-01 18:22 UTC*',
        ]);
    });

    it('lists reactions above the date', async () => {
        const s = setup();
        s.ports.add('10', '11', {
            reactions: [
                { name: '👍', count: 3 },
                { name: ':party:', count: 1 },
            ],
        });
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.deepEqual(s.ports.sent[0].content.split('\n'), [
            'message 11',
            'Reactions: 👍 3 · :party: 1',
            '*Originally posted 2024-03-01 18:22 UTC*',
        ]);
    });

    it('pins the copies of pinned messages once the channel is copied', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.add('10', '12');
        s.ports.pinned.set('10', ['12', '11', '99']);
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.deepEqual(s.ports.pins, ['f10 copy-2', 'f10 copy-1']);
    });

    it('logs a failed pin and still finishes', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.ports.pinned.set('10', ['11']);
        s.ports.pinCopy = async () => {
            throw new Error('Missing Permissions');
        };
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.equal(s.store.job('10').status, 'ready');
    });
});

describe('pass budget', () => {
    it('stops starting messages once the pass has run its budget', async () => {
        const s = setup();
        for (let i = 0; i < PAGE_SIZE; i++) s.ports.add('10', String(1000 + i));
        s.map('channel', '10', 'f10');
        assert.equal(await s.importer.run(LINK), true);
        const perPass = Math.ceil(PASS_BUDGET_MS / SEND_INTERVAL_MS);
        assert.equal(s.ports.sent.length, perPass);
        await s.drain();
        assert.equal(s.ports.sent.length, PAGE_SIZE);
    });
});

/** A Discord snowflake made at `ms` since the Unix epoch. */
const snowflakeOf = (ms: number) =>
    (BigInt(ms - 1_420_070_400_000) << BigInt(22)).toString();
/** When test bridges were made: before the test clock. */
const LINKED_AT = Date.parse('2026-11-20T09:00:00Z');

/** A text channel, the admin channel and a thread inside it. */
function adminGuild(): GuildSnapshot {
    return discordGuild({
        channels: [
            channel('10', { name: 'general' }),
            channel('40', { name: 'admin' }),
        ],
        threads: [
            {
                id: '400',
                parentId: '40',
                name: 'T',
                archived: false,
                locked: false,
                tags: [],
            },
        ],
    });
}

describe('the admin channel', () => {
    it('never gets a job, nor do its threads, and the end is still reported', async () => {
        const s = setup();
        s.state.snapshot = adminGuild();
        s.state.admin = '40';
        s.ports.add('10', '11');
        s.ports.add('40', '41');
        s.ports.add('400', '401');
        s.map('channel', '10', 'f10');
        s.map('channel', '40', 'f40');
        s.map('thread', '400', 'f400');
        await s.drain();
        assert.deepEqual(
            s.store.jobs.map((j) => j.discordId),
            ['10']
        );
        await s.links.link(LINK.id, '10', 'f10');
        await s.drain();
        assert.equal(s.ports.sent.length, 1);
        assert.match(
            s.reports.join('\n'),
            /History import finished: 1 messages copied/
        );
        assert.equal(await s.importer.waiting(LINK.id), false);
    });

    it('retires jobs made before the channel became the admin channel', async () => {
        const s = setup();
        s.state.snapshot = adminGuild();
        s.ports.add('40', '41');
        s.map('channel', '10', 'f10');
        s.map('channel', '40', 'f40');
        await s.drain();
        assert.equal(s.store.job('40').status, 'ready');
        assert.equal(s.store.job('400').status, 'pending');
        s.state.admin = '40';
        s.ports.add('40', '42');
        await s.links.link(LINK.id, '10', 'f10');
        await s.drain();
        assert.equal(s.store.job('40').status, 'done');
        assert.equal(s.store.job('400').status, 'done');
        assert.match(s.store.job('40').lastError ?? '', /admin channel/);
        assert.equal(s.ports.sent.length, 1);
        assert.equal(await s.importer.waiting(LINK.id), false);
        assert.match(s.reports.join('\n'), /History import finished/);
    });
});

describe('errors about the target', () => {
    it('fails the job instead of skipping messages when the import webhook is gone, and a retry makes a new one', async () => {
        const s = setup('apply', ['20', '30']);
        s.ports.add('10', '11');
        s.ports.add('10', '12');
        s.map('channel', '10', 'f10');
        s.ports.failure = Object.assign(new Error('Unknown Webhook'), {
            statusCode: 404,
            code: 'UNKNOWN_WEBHOOK',
        });
        s.ports.failNext = MAX_FAILURES;
        for (let i = 0; i < MAX_FAILURES; i++) {
            await s.importer.run(LINK);
            s.state.clock += RETRY_MAX_MS;
        }
        const job = s.store.job('10');
        assert.equal(job.status, 'failed');
        assert.equal(job.skipped, 0);
        assert.equal(job.importWebhook, null);
        assert.deepEqual(s.store.messages, []);
        assert.match(
            s.reports.join('\n'),
            /History import stopped for channel 10: Unknown Webhook/
        );
        assert.equal(await s.store.retryFailed(LINK.id), 1);
        await s.drain();
        assert.equal(s.ports.sent.length, 2);
        assert.equal(s.ports.webhooks, MAX_FAILURES + 1);
    });

    it('fails a job once MAX_SKIP_STREAK messages in a row are skipped, counting again after a copy', async () => {
        const s = setup('apply', ['20', '30']);
        for (let i = 0; i < 2 * MAX_SKIP_STREAK; i++)
            s.ports.add('10', String(100 + i));
        s.map('channel', '10', 'f10');
        const ok = String(100 + MAX_SKIP_STREAK - 1);
        const original = s.ports.sendCopy.bind(s.ports);
        s.ports.sendCopy = async (target, payload) => {
            if (payload.content.startsWith(`message ${ok}\n`))
                return original(target, payload);
            throw Object.assign(new Error('Invalid Form Body'), {
                statusCode: 400,
            });
        };
        const runs = 2 * MAX_SKIP_STREAK * MAX_FAILURES;
        for (let i = 0; i < runs; i++) {
            await s.importer.run(LINK);
            s.state.clock += RETRY_MAX_MS;
            if (s.store.job('10').status === 'failed') break;
        }
        const job = s.store.job('10');
        assert.equal(job.status, 'failed');
        assert.equal(job.imported, 1);
        assert.equal(job.skipped, 2 * MAX_SKIP_STREAK - 1);
        assert.match(
            s.reports.join('\n'),
            new RegExp(
                `${MAX_SKIP_STREAK} messages in a row could not be copied`
            )
        );
    });
});

describe('job limit', () => {
    it('stops making jobs at MAX_JOBS, warns once, and runs the jobs it has', async () => {
        const s = setup('apply', ['20']);
        await s.store.ensureJob(LINK.id, 'channel', 'filler', null);
        const filler = s.store.job('filler');
        s.store.jobs = Array.from({ length: MAX_JOBS - 1 }, (_, i) => ({
            ...filler,
            id: `filler-${i}`,
            discordId: `x${i}`,
            status: 'done' as const,
        }));
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.drain();
        await s.drain();
        assert.equal(s.store.jobs.length, MAX_JOBS);
        assert.equal(s.store.job('10').status, 'ready');
        assert.throws(() => s.store.job('30'));
        assert.equal(s.ports.sent.length, 1);
        assert.equal(s.reports.filter((r) => /reached/.test(r)).length, 1);
    });

    it('reads only open jobs while applying', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.equal(s.store.listings.get('listJobs'), undefined);
        assert.ok((s.store.listings.get('listOpenJobs') ?? 0) > 0);
    });
});

describe('channels bridged before their history', () => {
    it('copies the history from before the link into an archive thread, then is done', async () => {
        const s = setup('apply', ['20', '30']);
        const before = snowflakeOf(LINKED_AT - 60_000);
        const relayed = snowflakeOf(LINKED_AT - 30_000);
        const after = snowflakeOf(LINKED_AT + 60_000);
        s.ports.add('10', '11');
        s.ports.add('10', '12', { webhookId: 'dw-10' });
        s.ports.add('10', before);
        s.ports.add('10', relayed);
        s.ports.add('10', after);
        s.ports.relayed.add(relayed);
        s.map('channel', '10', 'f10');
        await s.links.link(LINK.id, '10', 'f10');
        s.ports.linkTimes.set('10', new Date(LINKED_AT));
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => [
                m.webhook,
                m.threadId,
                m.content.split('\n')[0],
            ]),
            [
                ['import-f10', 'thread-of-f10', 'message 11'],
                ['import-f10', 'thread-of-f10', `message ${before}`],
            ]
        );
        assert.equal(s.threadEdits[0], 'create f10 History before 2026-11-20');
        assert.equal(
            s.threadEdits[s.threadEdits.length - 1],
            'thread-of-f10 {"archived":true,"locked":true}'
        );
        assert.equal(s.store.job('10').status, 'done');
        assert.ok((await s.store.channelsReadyToBridge(LINK.id)).has('10'));
        assert.doesNotMatch(s.reports.join('\n'), /stopped/);
    });

    it('marks a voice channel bridged first done with a notice, as it cannot hold a thread', async () => {
        const s = setup('apply', ['10', '20']);
        s.ports.add('30', '31');
        s.map('channel', '30', 'f30');
        await s.links.link(LINK.id, '30', 'f30');
        await s.drain();
        assert.deepEqual(s.ports.sent, []);
        assert.equal(s.store.job('30').status, 'done');
        const reports = s.reports.join('\n');
        assert.match(
            reports,
            /bridged before its history was copied, and its Fluxer channel cannot hold an archive thread/
        );
        assert.match(reports, /History import finished/);
    });

    it('lets an admin retry a job that failed because its channel was bridged first', async () => {
        const s = setup('apply', ['20', '30']);
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.importer.planJobs(LINK);
        await s.store.updateJob(s.store.job('10').id, {
            status: 'failed',
            lastError: 'the channel was bridged before its history was copied',
        });
        await s.links.link(LINK.id, '10', 'f10');
        s.ports.linkTimes.set('10', new Date(LINKED_AT));
        assert.equal(await s.store.retryFailed(LINK.id), 1);
        await s.drain();
        assert.equal(s.store.job('10').status, 'done');
        assert.deepEqual(
            s.ports.sent.map((m) => m.threadId),
            ['thread-of-f10']
        );
    });
});

describe('archive threads and a late bridge', () => {
    it('keeps the archive open until the bridge exists, then copies up to the link', async () => {
        const s = setup('apply', ['20', '30'], 2);
        for (const id of ['11', '12', '13']) s.ports.add('10', id);
        s.map('channel', '10', 'f10');
        await s.drain();
        assert.equal(s.store.job('10').status, 'ready');
        assert.ok(!s.threadEdits.some((e) => e.includes('"archived":true')));
        assert.equal(await s.importer.waiting(LINK.id), true);
        const gap = snowflakeOf(LINKED_AT - 60_000);
        const relayed = snowflakeOf(LINKED_AT - 30_000);
        const live = snowflakeOf(LINKED_AT + 60_000);
        s.ports.add('10', gap);
        s.ports.add('10', relayed);
        s.ports.add('10', live);
        s.ports.relayed.add(relayed);
        await s.links.link(LINK.id, '10', 'f10');
        s.ports.linkTimes.set('10', new Date(LINKED_AT));
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.content.split('\n')[0]),
            ['message 11', 'message 12', 'message 13', `message ${gap}`]
        );
        assert.ok(s.ports.sent.every((m) => m.threadId === 'thread-of-f10'));
        assert.equal(s.store.job('10').status, 'done');
        assert.equal(
            s.threadEdits[s.threadEdits.length - 1],
            'thread-of-f10 {"archived":true,"locked":true}'
        );
    });
});

describe('leader lock', () => {
    it('stops copying once the lock is lost', async () => {
        const s = setup();
        for (const id of ['11', '12', '13']) s.ports.add('10', id);
        s.map('channel', '10', 'f10');
        let checks = 0;
        const held = async () => ++checks <= 1;
        await s.importer.run(LINK, s.state.clock + PASS_BUDGET_MS, held);
        assert.equal(s.ports.sent.length, 1);
        assert.equal(s.store.job('10').failures, 0);
    });

    it('looks for a cut-off copy across a full page of recent Fluxer messages', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.importer.planJobs(LINK);
        const job = s.store.job('10');
        await s.store.updateJob(job.id, {
            status: 'importing',
            cutoffId: '11',
            importWebhook: { id: 'import-f10', token: 'secret' },
        });
        await s.store.startMessage({
            discordMessageId: '11',
            jobId: job.id,
            discordAuthorId: 'author',
            fluxerMessageId: null,
            fluxerTargetId: 'f10',
            inThread: false,
            webhookId: 'import-f10',
        });
        // Ours is last in a full page: Fluxer returns up to 100 messages.
        assert.equal(RECOVERY_SCAN, 100);
        s.ports.recentCopies = [
            ...Array.from({ length: 99 }, (_, i) => ({
                id: `chat-${i}`,
                webhookId: 'someone',
                content: '',
            })),
            { id: 'ours', webhookId: 'import-f10', content: '' },
        ];
        await s.drain();
        assert.deepEqual(s.ports.sent, []);
        assert.equal(s.store.messages[0]?.fluxerMessageId, 'ours');
    });
});

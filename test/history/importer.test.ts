import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MapRow } from '../../src/guild-sync/ops';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import {
    HistoryImporter,
    MAX_FAILURES,
    MAX_GAP_PAGES,
    MAX_PARALLEL,
    PAGE_SIZE,
    PASS_BUDGET_MS,
    SEND_INTERVAL_MS,
    type HistoryMode,
} from '../../src/history/importer';
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

function setup(mode: HistoryMode = 'apply', excluded: string[] = []) {
    const store = new FakeHistoryStore();
    const ports = new FakeHistoryPorts();
    const links = new FakeLinker();
    const rows: MapRow[] = [];
    const state = {
        mode,
        snapshot: source() as GuildSnapshot | null,
        clock: Date.parse('2026-11-25T12:00:00Z'),
        clockMoves: true,
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
        writer: {
            async updateThread(_guild, id, patch) {
                threadEdits.push(`${id} ${JSON.stringify(patch)}`);
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

    it('marks a channel failed when it was bridged before its history', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        await s.links.link(LINK.id, '10', 'f10');
        await s.drain();
        assert.equal(s.store.job('10').status, 'failed');
        assert.deepEqual(s.ports.sent, []);
        assert.match(s.reports.join('\n'), /bridged before its history/);
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
        assert.deepEqual(s.threadEdits, [
            'f200 {"archived":false,"locked":false}',
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
        assert.match(
            s.ports.sent[0].content,
            /Attachments not copied: file0.png/
        );
    });

    it('retries a failed send on the next pass, and gives up after repeated failures', async () => {
        const s = setup();
        s.ports.add('10', '11');
        s.map('channel', '10', 'f10');
        s.ports.failNext = 1;
        await s.importer.run(LINK);
        assert.equal(s.store.job('10').failures, 1);
        assert.deepEqual(s.store.messages, []);
        await s.drain();
        assert.equal(s.ports.sent.length, 1);

        const t = setup();
        t.ports.add('10', '11');
        t.map('channel', '10', 'f10');
        t.ports.failNext = MAX_FAILURES;
        // A failed pass waits for the next one, as the loop does.
        for (let i = 0; i < MAX_FAILURES; i++) await t.importer.run(LINK);
        assert.equal(t.store.job('10').status, 'failed');
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
        s.ports.newestCopy = { id: 'already-sent', webhookId: 'import-f10' };
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
        s.ports.newestCopy = { id: 'already-sent', webhookId: 'import-f10' };
        await s.drain();
        assert.equal(s.ports.sent.length, 1);
        assert.equal(s.store.messages[0]?.fluxerMessageId, 'already-sent');

        const t = await crashedAfterSend(false);
        t.ports.newestCopy = { id: 'live', webhookId: 'someone-else' };
        await t.drain();
        assert.equal(t.ports.sent.length, 2);
        assert.equal(t.store.job('10').failures, 0);
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
    it('copies a voice channel and finishes without waiting for a bridge', async () => {
        const s = setup();
        s.ports.add('30', '31');
        s.map('channel', '30', 'f30');
        await s.drain();
        assert.deepEqual(
            s.ports.sent.map((m) => m.webhook),
            ['import-f30']
        );
        assert.equal(s.store.job('30').status, 'done');
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

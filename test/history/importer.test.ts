import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MapRow } from '../../src/guild-sync/ops';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import {
    HistoryImporter,
    MAX_FAILURES,
    PAGE_SIZE,
    SEND_INTERVAL_MS,
    type HistoryMode,
} from '../../src/history/importer';
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
    const state = { mode, snapshot: source() as GuildSnapshot | null };
    const reports: string[] = [];
    const threadEdits: string[] = [];
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
        mode: async () => state.mode,
        report: async (_link, _key, text) => {
            reports.push(text);
        },
        pause: async (ms) => {
            pauses.push(ms);
        },
        now: () => new Date('2026-11-25T12:00:00Z'),
        logger: createRecordingLogger(),
    });
    /** Maps a Discord channel or thread to its Fluxer copy. */
    const map = (
        kind: 'channel' | 'thread',
        discordId: string,
        fluxerId: string
    ) => rows.push(mapRow(kind, discordId, fluxerId));
    /** Runs passes until nothing is left, at most `limit`. */
    const drain = async (limit = 20) => {
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
        pauses,
        map,
        drain,
    };
}

describe('history jobs', () => {
    it('makes one job per text channel and per thread, none for voice or forums', async () => {
        const s = setup('dry-run');
        const jobs = await s.importer.planJobs(LINK);
        assert.deepEqual(jobs.map((j) => `${j.kind}:${j.discordId}`).sort(), [
            'channel:10',
            'thread:200',
        ]);
    });

    it('makes no job for an excluded channel or the threads inside it', async () => {
        const s = setup('dry-run', ['10', '20']);
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
        assert.match(s.reports[0] ?? '', /Channels: 1, 1 messages/);
        assert.match(s.reports[0] ?? '', /Posts and threads: 1, 2 replies/);
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

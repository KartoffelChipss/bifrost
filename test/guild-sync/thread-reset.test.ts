import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AddonMode } from '../../src/addons/config';
import { UnrecordedWriteError } from '../../src/addons/isolation';
import { latestIntent } from '../../src/guild-sync/adopt';
import {
    parseSyncCommand,
    resetRefusal,
    runSyncCommand,
} from '../../src/guild-sync/command';
import type { MapRow } from '../../src/guild-sync/ops';
import type { CopiedThread, SyncSettings } from '../../src/guild-sync/store';
import { HISTORY_LOCK_KEY, THREAD_RESET_OP } from '../../src/guild-sync/store';
import {
    MAX_RESET_THREADS,
    PendingResets,
    RESET_PREVIEW_TTL_MS,
    resetTargets,
} from '../../src/guild-sync/threadReset';
import {
    RESET_LOCK_ATTEMPTS,
    RESET_PACE_MS,
    ThreadResetPort,
    ThreadResetRunner,
    type ResetStart,
} from '../../src/guild-sync/threadResetJob';
import type { GuildWriter } from '../../src/guild-sync/writers/writer';
import { createRecordingLogger } from '../addons/fakes';
import {
    DEFAULT_SETTINGS,
    FakeStore,
    freshJob,
    recordingNotices,
} from './fake-store';
import { channel, discordGuild, mapRow } from './fixtures';
import { LINK, setup } from './harness';

const APPLY = {
    ...DEFAULT_SETTINGS,
    mode: 'apply' as const,
    adminChannelId: 'admin',
};

/** Two copied threads in `forum`, one in `text`, one recorded from Fluxer. */
function threadRows(): MapRow[] {
    return [
        mapRow('channel', 'forum', 'f-forum', { id: 'row-a' }),
        mapRow('thread', 't1', 'f-t1', { id: 'row-b' }),
        mapRow('thread', 't2', 'f-t2', { id: 'row-c' }),
        mapRow('thread', 't3', 'f-t3', { id: 'row-d' }),
        mapRow('thread', 'mirror', 'f-mirror', {
            id: 'row-e',
            createdBySync: false,
        }),
        mapRow('thread', 'old', 'f-old', {
            id: 'row-f',
            state: 'tombstoned',
        }),
    ];
}

const source = discordGuild({
    channels: [channel('forum', { type: 15 }), channel('text')],
    threads: [
        {
            id: 't1',
            parentId: 'forum',
            name: 'One',
            archived: false,
            locked: false,
            tags: [],
        },
        {
            id: 't2',
            parentId: 'forum',
            name: 'Two',
            archived: false,
            locked: false,
            tags: [],
        },
        {
            id: 't3',
            parentId: 'text',
            name: 'Three',
            archived: false,
            locked: false,
            tags: [],
        },
    ],
});

const COPIED = ['t1', 't2', 't3'];

describe('parseSyncCommand reset-threads', () => {
    it('reads the preview and the confirmation', () => {
        assert.deepEqual(parseSyncCommand(['reset-threads']), {
            type: 'reset-threads',
            confirm: false,
        });
        assert.deepEqual(parseSyncCommand(['reset-threads', 'CONFIRM']), {
            type: 'reset-threads',
            confirm: true,
        });
    });

    it('rejects anything else', () => {
        const bad = [
            ['reset-threads', 'now'],
            ['reset-threads', 'confirm', 'abcd1234'],
            ['reset-threads', 'abcd1234'],
        ];
        for (const args of bad) {
            assert.equal(parseSyncCommand(args).type, 'error', args.join(' '));
        }
    });
});

describe('resetTargets', () => {
    it('takes only active thread rows created by sync', () => {
        const found = resetTargets(threadRows(), source);
        assert.deepEqual(
            found.targets.map((t) => t.discordId),
            COPIED
        );
        assert.equal(found.copied, 3);
        assert.equal(found.recorded, 1);
        assert.deepEqual(
            found.targets.map((t) => t.parentId),
            ['forum', 'forum', 'text']
        );
    });

    it('stops at the cap and says how many wait', () => {
        const rows = Array.from({ length: MAX_RESET_THREADS + 3 }, (_, i) =>
            mapRow('thread', `d${i}`, `f${i}`, {
                id: `r${String(i).padStart(4, '0')}`,
            })
        );
        const found = resetTargets(rows, null);
        assert.equal(found.targets.length, MAX_RESET_THREADS);
        assert.equal(found.copied, MAX_RESET_THREADS + 3);
        assert.equal(found.targets[0].parentId, null);
    });
});

/** BF_ADDONS_RESET_USER_ID in these tests. */
const RESET_USER = '200000000000000001';

/** A command context with a launcher that records what it was given. */
function commandSetup(
    start: ResetStart = 'started',
    userId: string | null = RESET_USER
) {
    const store = new FakeStore();
    store.settings = APPLY;
    store.rows = threadRows();
    store.snapshots = [{ snapshot: source, healthy: true }];
    const launched: CopiedThread[][] = [];
    const changed: string[] = [];
    const clock = { now: new Date('2026-11-25T12:00:00Z') };
    const reset = {
        pending: new PendingResets(),
        launcher: {
            start: (_link: unknown, targets: readonly CopiedThread[]) => {
                launched.push([...targets]);
                return start;
            },
        },
        allowApply: true,
        userId,
    };
    const run = (confirm: boolean, link = LINK, author = RESET_USER) =>
        runSyncCommand(
            { type: 'reset-threads', confirm },
            link,
            'admin',
            {
                store,
                isChannelLinked: async () => false,
                changed: (id) => changed.push(id),
                threadReset: reset,
                now: () => clock.now,
            },
            author
        );
    const preview = async () => {
        const out = await run(false);
        assert.equal(typeof out, 'object');
        return (out as { note: string; alone?: boolean }).note;
    };
    const confirm = (link = LINK, author = RESET_USER) =>
        run(true, link, author);
    return { store, launched, changed, clock, reset, run, preview, confirm };
}

describe('sync reset-threads access', () => {
    it('is off while BF_ADDONS_RESET_USER_ID is unset or invalid', async () => {
        const c = commandSetup('started', null);
        assert.match(String(await c.run(false)), /not set up/);
        assert.match(String(await c.run(true)), /not set up/);
        assert.equal(
            resetRefusal(undefined, RESET_USER),
            resetRefusal(c.reset, RESET_USER)
        );
        assert.deepEqual(c.launched, []);
    });

    it('refuses everyone but the configured user', async () => {
        const c = commandSetup();
        const owner = '300000000000000003';
        assert.match(String(await c.run(false, LINK, owner)), /Only the user/);
        await c.preview();
        assert.match(String(await c.confirm(LINK, owner)), /Only the user/);
        assert.deepEqual(c.launched, []);
    });
});

describe('sync reset-threads preview', () => {
    it('counts per parent channel, and copies against recorded threads', async () => {
        const c = commandSetup();
        const text = await c.preview();
        assert.match(text, /created by sync: \*\*3\*\*/);
        assert.match(text, /recorded from Fluxer \(1\)/);
        assert.match(text, /<#forum>: 2/);
        assert.match(text, /<#text>: 1/);
        assert.match(text, /`sync reset-threads confirm`/);
        // Showing changes nothing, so no status update is asked for.
        assert.deepEqual(c.changed, []);
        assert.deepEqual(c.launched, []);
        assert.equal(c.store.rows.length, threadRows().length);
    });

    it('offers no confirmation when the reset could not run', async () => {
        const c = commandSetup();
        c.store.settings = { ...APPLY, killSwitch: true };
        const text = await c.preview();
        assert.match(text, /Cannot run now: The kill switch is on/);
        assert.doesNotMatch(text, /confirm/);
        c.store.settings = APPLY;
        assert.match(String(await c.confirm()), /No reset preview/);
    });
});

describe('sync reset-threads confirm', () => {
    it('runs exactly the previewed copies for the configured user', async () => {
        const c = commandSetup();
        await c.preview();
        const out = await c.confirm();
        assert.match((out as { note: string }).note, /Resetting 3 thread/);
        assert.deepEqual(
            c.launched.map((set) => set.map((t) => t.discordId)),
            [COPIED]
        );
        assert.deepEqual(c.changed, [LINK.id]);
        // A preview is confirmed once.
        assert.match(String(await c.confirm()), /No reset preview/);
        assert.equal(c.launched.length, 1);
    });

    it('refuses without a preview, or with a preview on another link', async () => {
        const c = commandSetup();
        assert.match(String(await c.confirm()), /No reset preview/);
        await c.preview();
        const other = { ...LINK, id: 'link-2' };
        assert.match(String(await c.confirm(other)), /No reset preview/);
        assert.deepEqual(c.launched, []);
    });

    it('refuses an expired preview', async () => {
        const c = commandSetup();
        await c.preview();
        c.clock.now = new Date(
            c.clock.now.getTime() + RESET_PREVIEW_TTL_MS + 1
        );
        assert.match(String(await c.confirm()), /No reset preview/);
        assert.deepEqual(c.launched, []);
    });

    it('refuses once the set of threads changed since the preview', async () => {
        const c = commandSetup();
        await c.preview();
        c.store.rows = [...c.store.rows, mapRow('thread', 't9', 'f-t9')];
        assert.match(String(await c.confirm()), /changed since your preview/);
        assert.deepEqual(c.launched, []);
    });

    it('refuses outside apply, without allow-apply, with the kill switch, or from Fluxer', async () => {
        const cases: [Partial<SyncSettings>, boolean, RegExp][] = [
            [{ killSwitch: true }, true, /kill switch is on/],
            [{ mode: 'dry-run' }, true, /dry-run mode/],
            [{}, false, /BF_ADDONS_ALLOW_APPLY/],
            [{ direction: 'fluxer-to-discord' }, true, /Discord is the source/],
        ];
        for (const [settings, allowApply, reply] of cases) {
            const c = commandSetup();
            await c.preview();
            c.store.settings = { ...APPLY, ...settings };
            const reset = { ...c.reset, allowApply };
            const out = await runSyncCommand(
                { type: 'reset-threads', confirm: true },
                LINK,
                'admin',
                {
                    store: c.store,
                    isChannelLinked: async () => false,
                    threadReset: reset,
                    now: () => c.clock.now,
                },
                RESET_USER
            );
            assert.match(String(out), reply);
            assert.deepEqual(c.launched, []);
        }
    });

    it('says so when a reset runs already or guild-sync is not running', async () => {
        const busy = commandSetup('busy');
        await busy.preview();
        assert.match(String(await busy.confirm()), /already running/);
        const port = new ThreadResetPort();
        assert.equal(port.start(LINK, []), 'unavailable');
    });
});

/** A Fluxer writer that answers deletes from a script. */
class FakeWriter {
    readonly deleted: string[] = [];
    readonly notFound = new Set<string>();
    readonly refuse = new Set<string>();
    /** Called before each delete, for a test that changes settings. */
    before: (id: string) => void = () => {};

    async deleteThread(_guild: string, id: string): Promise<void> {
        this.before(id);
        if (this.notFound.has(id)) {
            throw Object.assign(new Error('Unknown Channel'), {
                statusCode: 404,
            });
        }
        if (this.refuse.has(id)) throw new Error('500 from Fluxer');
        this.deleted.push(id);
    }
}

function runnerSetup(
    store = new FakeStore(),
    options: {
        mode?: AddonMode;
        deleteWith?: Pick<GuildWriter, 'deleteThread'>;
    } = {}
) {
    const mode = options.mode ?? 'apply';
    if (store.rows.length === 0) store.rows = threadRows();
    store.settings = { ...store.settings, ...APPLY };
    const writer = new FakeWriter();
    const notices = recordingNotices();
    const pauses: number[] = [];
    const tripped: unknown[] = [];
    const changed: string[] = [];
    let seq = 0;
    const runner = new ThreadResetRunner({
        store,
        writer: options.deleteWith ?? writer,
        notices: notices.board,
        processMode: () => mode,
        allowApply: true,
        holder: 'test',
        isolate: async (run) => {
            try {
                await run();
            } catch (error) {
                tripped.push(error);
            }
        },
        changed: (id) => changed.push(id),
        pause: async (ms) => {
            pauses.push(ms);
        },
        now: () => new Date('2026-11-25T12:00:00Z'),
        newId: () =>
            `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
        logger: createRecordingLogger(),
    });
    const targets = () => resetTargets(store.rows, null).targets;
    const reset = async (link = LINK) => {
        assert.equal(runner.start(link, targets()), 'started');
        await runner.idle();
    };
    return {
        store,
        writer,
        runner,
        posted: notices.posted,
        pauses,
        tripped,
        changed,
        targets,
        reset,
    };
}

const threadIds = (rows: readonly MapRow[]) =>
    rows.filter((r) => r.kind === 'thread').map((r) => r.discordId);

describe('ThreadResetRunner', () => {
    it('deletes only the copies made by sync, paced, and forgets them', async () => {
        const r = runnerSetup();
        await r.reset();
        assert.deepEqual(r.writer.deleted, ['f-t1', 'f-t2', 'f-t3']);
        assert.deepEqual(threadIds(r.store.rows), ['mirror', 'old']);
        assert.equal(
            r.store.rows.some((row) => row.kind === 'channel'),
            true
        );
        assert.deepEqual(r.pauses, [RESET_PACE_MS, RESET_PACE_MS]);
        assert.match(r.posted[0].text, /finished: 3 deleted, 0 already gone/);
        assert.equal(r.posted[0].channelId, 'admin');
        assert.deepEqual(r.changed, [LINK.id]);
        const audits = r.store.audits.filter((a) => a.op === THREAD_RESET_OP);
        assert.deepEqual(
            audits.map((a) => [a.sourceId, a.destId, a.result]),
            [
                ['t1', 'f-t1', 'ok'],
                ['t2', 'f-t2', 'ok'],
                ['t3', 'f-t3', 'ok'],
            ]
        );
        // A reset is not a removal: it leaves the delete budget alone.
        assert.equal(await r.store.removalsSince(), 0);
    });

    it('counts a 404 as already gone and still forgets the thread', async () => {
        const r = runnerSetup();
        r.writer.notFound.add('f-t2');
        await r.reset();
        assert.deepEqual(r.writer.deleted, ['f-t1', 'f-t3']);
        assert.deepEqual(threadIds(r.store.rows), ['mirror', 'old']);
        assert.match(r.posted[0].text, /2 deleted, 1 already gone, 0 failed/);
    });

    it('keeps a thread whose delete failed and audits the failure', async () => {
        const r = runnerSetup();
        r.writer.refuse.add('f-t2');
        await r.reset();
        assert.deepEqual(threadIds(r.store.rows), ['t2', 'mirror', 'old']);
        const failed = r.store.audits.find((a) => a.result === 'failed');
        assert.equal(failed?.destId, 'f-t2');
        assert.match(r.posted[0].text, /2 deleted, 0 already gone, 1 failed/);
        assert.match(r.posted[0].text, /run `sync reset-threads` again/);
    });

    it('stops when the kill switch flips mid-run', async () => {
        const r = runnerSetup();
        r.writer.before = (id) => {
            if (id === 'f-t1') {
                r.store.settings = { ...r.store.settings, killSwitch: true };
            }
        };
        await r.reset();
        assert.deepEqual(r.writer.deleted, ['f-t1']);
        assert.deepEqual(threadIds(r.store.rows), [
            't2',
            't3',
            'mirror',
            'old',
        ]);
        assert.match(r.posted[0].text, /stopped \(kill switch is on\)/);
        assert.match(r.posted[0].text, /2 threads not tried/);
    });

    it('stops when the link leaves apply mode or the lock is lost', async () => {
        const r = runnerSetup();
        r.writer.before = () => {
            r.store.settings = { ...r.store.settings, mode: 'dry-run' };
        };
        await r.reset();
        assert.deepEqual(r.writer.deleted, ['f-t1']);
        const lost = runnerSetup();
        lost.store.lockLost = true;
        await lost.reset();
        assert.deepEqual(lost.writer.deleted, []);
        assert.match(lost.posted[0].text, /leader lock was lost/);
    });

    it('does not delete anything while the process is read-only', async () => {
        const r = runnerSetup(new FakeStore(), { mode: 'read-only' });
        await r.reset();
        assert.deepEqual(r.writer.deleted, []);
        assert.equal(threadIds(r.store.rows).length, 5);
    });

    it('waits for a running cycle and gives up without deleting', async () => {
        const r = runnerSetup();
        r.store.lockHeld = true;
        await r.reset();
        assert.deepEqual(r.writer.deleted, []);
        assert.equal(r.pauses.length, RESET_LOCK_ATTEMPTS - 1);
        assert.match(r.posted[0].text, /did not start/);
    });

    it('waits for a running history pass too', async () => {
        const r = runnerSetup();
        r.store.heldKeys.add(HISTORY_LOCK_KEY);
        await r.reset();
        assert.deepEqual(r.writer.deleted, []);
        assert.match(r.posted[0].text, /did not start/);
    });

    it('holds both locks while it deletes', async () => {
        const r = runnerSetup();
        const seen: boolean[] = [];
        r.writer.before = () => {
            seen.push(r.store.lockHeld, r.store.heldKeys.has(HISTORY_LOCK_KEY));
        };
        await r.reset();
        assert.deepEqual(seen, [true, true, true, true, true, true]);
        assert.equal(r.store.lockHeld, false);
    });

    it('runs one reset at a time', async () => {
        const r = runnerSetup();
        assert.equal(r.runner.start(LINK, r.targets()), 'started');
        assert.equal(r.runner.start(LINK, r.targets()), 'busy');
        await r.runner.idle();
        assert.equal(r.runner.start(LINK, []), 'started');
        await r.runner.stop();
        assert.equal(r.runner.start(LINK, []), 'unavailable');
    });

    it('skips a target whose row changed after the confirmation', async () => {
        const r = runnerSetup();
        const targets = r.targets();
        r.store.rows = r.store.rows.map((row) =>
            row.discordId === 't2' ? { ...row, fluxerId: 'f-other' } : row
        );
        r.runner.start(LINK, targets);
        await r.runner.idle();
        assert.deepEqual(r.writer.deleted, ['f-t1', 'f-t3']);
        assert.match(r.posted[0].text, /1 skipped as changed/);
    });

    it('trips read-only when a deleted thread cannot be forgotten', async () => {
        const r = runnerSetup();
        r.store.failForget = true;
        await r.reset();
        assert.deepEqual(r.writer.deleted, ['f-t1']);
        assert.ok(r.tripped[0] instanceof UnrecordedWriteError);
        assert.match(r.posted[0].text, /stopped \(Fluxer thread f-t1 is gone/);
    });
});

describe('what a reset clears', () => {
    function seeded() {
        const store = new FakeStore();
        store.rows = threadRows();
        store.threadMessages = [
            ['t1', 'f-t1', 'd-m1', 'f-m1'],
            ['t2', 'f-t2', 'd-m2', 'f-m2'],
            ['mirror', 'f-mirror', 'd-m3', 'f-m3'],
        ].map(([dt, ft, dm, fm]) => ({
            guildLinkId: LINK.id,
            discordThreadId: dt,
            fluxerThreadId: ft,
            discordMessageId: dm,
            fluxerMessageId: fm,
        }));
        store.parked = [
            { side: 'discord', threadId: 't1', messageId: 'p1' },
            { side: 'fluxer', threadId: 'f-t3', messageId: 'p2' },
            { side: 'discord', threadId: 'mirror', messageId: 'p3' },
        ];
        store.historyJobs = [
            freshJob('job-1', 't1', {
                status: 'done',
                fluxerId: 'f-t1',
                cutoffId: '500',
                checkpointId: '500',
                imported: 12,
                skipped: 1,
                lastError: 'boom',
                surveyedAt: new Date(),
                importWebhook: { id: 'w', token: 'secret' },
            }),
            freshJob('job-2', 'mirror', {
                status: 'done',
                fluxerId: 'f-mirror',
            }),
        ];
        store.historyMessages = [
            { discordMessageId: 'h1', jobId: 'job-1' },
            { discordMessageId: 'h2', jobId: 'job-2' },
        ];
        return store;
    }

    it('clears pairs, parked replies, history and map rows of exactly those threads', async () => {
        const r = runnerSetup(seeded());
        await r.reset();
        const { store } = r;
        assert.deepEqual(
            store.threadMessages.map((m) => m.discordThreadId),
            ['mirror']
        );
        assert.deepEqual(
            store.parked.map((p) => p.messageId),
            ['p3']
        );
        assert.deepEqual(
            store.historyMessages.map((m) => m.discordMessageId),
            ['h2']
        );
        assert.deepEqual(store.historyJobs[0], freshJob('job-1', 't1'));
        assert.equal(store.historyJobs[1].status, 'done');
        assert.equal(store.historyJobs[1].fluxerId, 'f-mirror');
        assert.deepEqual(
            store.forgotten.map((t) => t.discordId),
            COPIED
        );
    });

    it('answers the create intents of those threads with a refusal', async () => {
        const store = seeded();
        const intentAt = new Date('2026-11-25T11:00:00Z');
        for (const sourceId of ['t1', 'mirror']) {
            await store.audit(
                {
                    planId: 'p',
                    guildLinkId: LINK.id,
                    op: 'create-intent',
                    kind: 'thread',
                    sourceId,
                    destId: null,
                    before: null,
                    after: { name: 'One' },
                    result: 'intent',
                },
                intentAt
            );
        }
        const r = runnerSetup(store);
        await r.reset();
        const intents = await store.createIntents(LINK.id, new Date(0));
        const key = (sourceId: string) =>
            latestIntent(intents, { kind: 'thread', sourceId, name: 'One' });
        assert.equal(key('t1'), null);
        assert.notEqual(key('mirror'), null);
    });
});

describe('after a reset', () => {
    const forum = () =>
        discordGuild({
            channels: [channel('forum', { type: 15, name: 'game-chat' })],
            threads: [
                {
                    id: 'post1',
                    parentId: 'forum',
                    name: 'First',
                    archived: false,
                    locked: false,
                    tags: [],
                },
                {
                    id: 'post2',
                    parentId: 'forum',
                    name: 'Second',
                    archived: false,
                    locked: false,
                    tags: [],
                },
            ],
        });

    it('lets the next cycle plan a fresh create for each thread', async () => {
        const s = setup(forum());
        s.useLinks();
        for (let i = 0; i < 4; i++) await s.cycle();
        const copies = s.store.rows.filter((row) => row.kind === 'thread');
        assert.equal(copies.length, 2);
        const r = runnerSetup(s.store, { deleteWith: s.guild });
        await r.reset();
        assert.equal(s.guild.snapshot.threads.length, 0);
        s.wait(1);
        const next = await s.cycle();
        const creates = next.plan.body.ops.filter(
            (op) => op.op === 'create' && op.kind === 'thread'
        );
        assert.deepEqual(
            creates.map((op) => ('sourceId' in op ? op.sourceId : '')).sort(),
            ['post1', 'post2']
        );
        assert.equal(
            creates.some((op) => op.op === 'create' && op.adopt),
            false
        );
        assert.equal(s.guild.snapshot.threads.length, 2);
    });
});

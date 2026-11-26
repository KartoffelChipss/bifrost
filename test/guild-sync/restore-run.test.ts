import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MapRow } from '../../src/guild-sync/ops';
import { restoreItem } from '../../src/guild-sync/restore';
import {
    runRestores,
    type RestoreRunDeps,
} from '../../src/guild-sync/restoreCycle';
import { HISTORY_LOCK_KEY } from '../../src/guild-sync/store';
import { createRecordingLogger } from '../addons/fakes';
import { FakeLinker, FakeReader, FakeStore } from './fake-store';
import { channel, discordGuild, mapRow } from './fixtures';
import { LINK, NOW } from './harness';

const source = discordGuild({
    channels: [channel('chan', { type: 15 })],
    threads: [
        {
            id: 't1',
            parentId: 'chan',
            name: 'One',
            archived: false,
            locked: false,
            tags: [],
        },
    ],
});

function world(rows: MapRow[]) {
    const store = new FakeStore();
    store.rows = rows;
    const linker = new FakeLinker();
    const reader = new FakeReader(
        { ok: false, reason: 'error', detail: 'unused' },
        new Set(rows.map((r) => r.fluxerId ?? ''))
    );
    const state = { stopped: null as string | null, leader: true };
    const deps: RestoreRunDeps = {
        store,
        reader,
        links: linker,
        writesStopped: async () => state.stopped,
        stillLeader: async () => state.leader,
        holder: 'test',
        now: () => NOW,
        logger: createRecordingLogger(),
    };
    const run = (items: MapRow[]) =>
        runRestores(
            {
                guildLinkId: LINK.id,
                fluxerGuildId: LINK.fluxerGuildId,
                items: items.map((r) => restoreItem(r, 'name')),
                runId: 'plan-1',
                source,
            },
            deps
        );
    return { store, linker, reader, state, run };
}

describe('runRestores', () => {
    it('unlinks a channel, forgets it with its thread copies, and holds the history lock', async () => {
        const chan = mapRow('channel', 'chan', 'f-chan');
        const thread = mapRow('thread', 't1', 'f-t1');
        const role = mapRow('role', 'r1', 'f-r1');
        const w = world([chan, thread, role]);
        let lockHeld = false;
        const restore = w.store.restoreCopy.bind(w.store);
        w.store.restoreCopy = (...args) => {
            lockHeld = w.store.heldKeys.has(HISTORY_LOCK_KEY);
            return restore(...args);
        };

        const result = await w.run([chan, role]);

        assert.equal(result.restored, 2);
        assert.equal(lockHeld, true);
        assert.deepEqual(w.linker.unlinked, ['chan']);
        assert.deepEqual(
            w.store.restored.map((t) => [t.kind, t.threads.length]),
            [
                ['channel', 1],
                ['role', 0],
            ]
        );
        assert.deepEqual(w.store.rows, []);
    });

    it('waits while a history pass holds the history lock', async () => {
        const role = mapRow('role', 'r1', 'f-r1');
        const w = world([role]);
        w.store.heldKeys.add(HISTORY_LOCK_KEY);
        const result = await w.run([role]);
        assert.equal(result.restored, 0);
        assert.match(result.stopped ?? '', /history pass/);
        assert.deepEqual(w.store.rows, [role]);
    });

    it('stops on the kill switch, a mode change or a lost lock', async () => {
        const role = mapRow('role', 'r1', 'f-r1');
        for (const trip of ['writes', 'leader'] as const) {
            const w = world([role]);
            if (trip === 'writes') w.state.stopped = 'kill switch is on';
            else w.state.leader = false;
            const result = await w.run([role]);
            assert.equal(result.restored, 0, trip);
            assert.ok(result.stopped, trip);
            assert.deepEqual(w.store.restored, [], trip);
        }
    });

    it('leaves a copy the lookup no longer confirms, or whose row changed', async () => {
        const kept = mapRow('emoji', 'e1', 'f-e1');
        const changed = mapRow('sticker', 's1', 'f-s1');
        const w = world([kept, changed]);
        w.reader.gone = new Set();
        const first = await w.run([kept]);
        assert.equal(first.notConfirmed, 1);
        w.reader.gone = new Set(['f-s1']);
        w.store.rows = [kept, { ...changed, createdBySync: false }];
        const second = await w.run([changed]);
        assert.equal(second.changed, 1);
        assert.deepEqual(w.store.restored, []);
        assert.equal(w.store.rows.length, 2);
    });

    it('stops at the first failure and never unlinks for other kinds', async () => {
        const a = mapRow('category', 'k1', 'f-k1');
        const b = mapRow('category', 'k2', 'f-k2');
        const w = world([a, b]);
        w.store.failRestore = true;
        const result = await w.run([a, b]);
        assert.equal(result.failed, 1);
        assert.equal(result.restored, 0);
        assert.equal(w.reader.lookups, 1);
        assert.deepEqual(w.linker.unlinked, []);
    });
});

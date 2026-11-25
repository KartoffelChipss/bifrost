import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lookupBatch, MAX_LOOKUPS_PER_CYCLE } from '../../src/guild-sync/cycle';
import { diff } from '../../src/guild-sync/diff';
import {
    backoffMs,
    FAILURES_BEFORE_BACKOFF,
    FIRST_BACKOFF_MS,
    MAX_BACKOFF_MS,
    MemoryFailureLedger,
} from '../../src/guild-sync/failures';
import { IdMap } from '../../src/guild-sync/idmap';
import type { PlanOp } from '../../src/guild-sync/ops';
import { writeFor, type WriteContext } from '../../src/guild-sync/writes';
import {
    D_GUILD,
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    mapRow,
} from './fixtures';

function context(source = discordGuild(), destination = fluxerGuild()) {
    const ctx: WriteContext = {
        source,
        destination,
        direction: 'discord-to-fluxer',
        map: new IdMap([], 'discord-to-fluxer', D_GUILD, F_GUILD),
    };
    return ctx;
}

const update = (
    kind: PlanOp['kind'],
    changes: { field: string; from: never; to: never }[] | object[],
    settled?: Record<string, string | boolean>
): PlanOp =>
    ({
        op: 'update',
        kind,
        sourceId: 's1',
        destId: 'd1',
        changes,
        ...(settled ? { settled } : {}),
    }) as PlanOp;

describe('what an update records as its base', () => {
    it('records the settled fields, never fields it did not write', () => {
        const ctx = context(
            discordGuild({ channels: [channel('s1', { name: 'new' })] }),
            fluxerGuild({ channels: [channel('d1', { name: 'old' })] })
        );
        const action = writeFor(
            update('channel', [{ field: 'name', from: 'old', to: 'new' }], {
                name: 'new',
                topic: 'same',
            }),
            ctx
        );
        assert.ok('applied' in action);
        // parentId was neither changed nor equal at plan time: left out.
        assert.deepEqual(action.applied, { name: 'new', topic: 'same' });
    });

    it('records only the changes for a plan saved before `settled`', () => {
        const ctx = context(
            discordGuild({ channels: [channel('s1', { name: 'new' })] }),
            fluxerGuild({ channels: [channel('d1', { name: 'old' })] })
        );
        const action = writeFor(
            update('channel', [{ field: 'name', from: 'old', to: 'new' }]),
            ctx
        );
        assert.ok('applied' in action);
        assert.deepEqual(action.applied, { name: 'new' });
    });

    it('leaves out sticker tags, which Fluxer cannot change', () => {
        const ctx = context(
            discordGuild({
                stickers: [
                    { id: 's1', name: 'new', description: '', tags: 'b' },
                ],
            })
        );
        const action = writeFor(
            update(
                'sticker',
                [
                    { field: 'name', from: 'old', to: 'new' },
                    { field: 'tags', from: 'a', to: 'b' },
                ],
                { name: 'new', tags: 'b' }
            ),
            ctx
        );
        assert.ok(action.type === 'update-sticker');
        assert.deepEqual(action.applied, { name: 'new' });
    });

    it('treats an archive of an object already gone as done', () => {
        const action = writeFor(
            { op: 'archive', kind: 'channel', sourceId: 's1', destId: 'd1' },
            context()
        );
        assert.equal(action.type, 'gone');
    });
});

describe('thread names', () => {
    it('never adopts an unowned post that shares a name', () => {
        const result = diff({
            source: discordGuild({
                channels: [channel('forum', { type: 15 })],
                threads: [
                    {
                        id: 't1',
                        parentId: 'forum',
                        name: 'Help',
                        archived: false,
                        locked: false,
                        tags: [],
                    },
                ],
            }),
            destination: fluxerGuild({
                channels: [channel('fforum', { type: 15 })],
                threads: [
                    {
                        id: 'theirs',
                        parentId: 'fforum',
                        name: 'Help',
                        archived: false,
                        locked: false,
                        tags: [],
                    },
                ],
            }),
            previousSource: null,
            rows: [mapRow('channel', 'forum', 'fforum')],
            direction: 'discord-to-fluxer',
        });
        const create = result.ops.find(
            (op) => op.op === 'create' && op.kind === 'thread'
        );
        assert.ok(create?.op === 'create');
        assert.equal(create.existingDestId, null);
    });
});

describe('removal lookups', () => {
    it('looks up the longest-unchecked candidates first', () => {
        const rows = Array.from({ length: MAX_LOOKUPS_PER_CYCLE + 5 }, (_, i) =>
            mapRow('thread', `t${i}`, `f${i}`, {
                missingSince: new Date(1000 + i),
            })
        );
        const first = lookupBatch(rows, new Map());
        assert.equal(first.length, MAX_LOOKUPS_PER_CYCLE);
        const checked = new Map(first.map((row) => [row.id, 5000]));
        const second = lookupBatch(rows, checked);
        // The five never checked come first in the next cycle.
        const fresh = rows.slice(MAX_LOOKUPS_PER_CYCLE).map((r) => r.id);
        assert.deepEqual(
            second.slice(0, 5).map((r) => r.id),
            fresh
        );
    });
});

describe('failure backoff', () => {
    it('waits only after repeated failures, growing to a cap', () => {
        assert.equal(backoffMs(FAILURES_BEFORE_BACKOFF - 1), 0);
        assert.equal(backoffMs(FAILURES_BEFORE_BACKOFF), FIRST_BACKOFF_MS);
        assert.equal(
            backoffMs(FAILURES_BEFORE_BACKOFF + 1),
            2 * FIRST_BACKOFF_MS
        );
        assert.equal(backoffMs(100), MAX_BACKOFF_MS);
    });

    it('clears an op once it succeeds', () => {
        const ledger = new MemoryFailureLedger();
        const now = new Date(0);
        for (let i = 0; i < FAILURES_BEFORE_BACKOFF; i++) {
            ledger.failed('k', now);
        }
        assert.equal(ledger.blocked('k', now), true);
        assert.equal(
            ledger.blocked('k', new Date(FIRST_BACKOFF_MS + 1)),
            false
        );
        ledger.succeeded('k');
        ledger.failed('k', now);
        assert.equal(ledger.blocked('k', now), false);
    });
});

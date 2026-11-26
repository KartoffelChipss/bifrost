import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissingCopy } from '../../src/guild-sync/diff';
import type { MapRow } from '../../src/guild-sync/ops';
import {
    MAX_RESTORES_PER_CYCLE,
    MAX_RESTORES_PER_DAY,
    allowedRestores,
    applyDestMissing,
    childThreads,
    destinationHealthy,
    massMissing,
    restoreCandidates,
    restoreItem,
    restoreRoom,
    trackDestMissing,
} from '../../src/guild-sync/restore';
import { DEFAULT_SETTINGS } from './fake-store';
import {
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    mapRow,
    role,
} from './fixtures';

const NOW = new Date('2026-11-25T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const SETTINGS = {
    ...DEFAULT_SETTINGS,
    direction: 'discord-to-fluxer' as const,
};

/** A copy missing for `count` checks since `minutes` ago. */
function missingRow(
    kind: MapRow['kind'],
    discordId: string,
    fluxerId: string,
    count: number,
    minutes: number,
    overrides: Partial<MapRow> = {}
): MapRow {
    return mapRow(kind, discordId, fluxerId, {
        destMissingCount: count,
        destMissingSince: minutesAgo(minutes),
        ...overrides,
    });
}

const missingOf = (row: MapRow, name = 'name'): MissingCopy => ({
    kind: row.kind as MissingCopy['kind'],
    sourceId: row.discordId ?? '',
    destId: row.fluxerId ?? '',
    name,
});

const thread = (id: string, parentId: string) => ({
    id,
    parentId,
    name: id,
    archived: false,
    locked: false,
    tags: [],
});

describe('trackDestMissing', () => {
    const destination = fluxerGuild({
        roles: [role(F_GUILD), role('f-role')],
        channels: [channel('f-chan'), channel('f-forum', { type: 15 })],
        threads: [thread('f-t1', 'f-forum')],
    });

    it('counts a missing copy and resets one that is back', () => {
        const gone = mapRow('channel', 'c-gone', 'f-gone');
        const back = mapRow('role', 'r', 'f-role', {
            destMissingCount: 2,
            destMissingSince: minutesAgo(20),
        });
        const there = mapRow('channel', 'c', 'f-chan');
        const updates = trackDestMissing(
            [gone, back, there],
            destination,
            'discord-to-fluxer',
            NOW
        );
        assert.deepEqual(updates, [
            { rowId: gone.id, destMissingCount: 1, destMissingSince: NOW },
            { rowId: back.id, destMissingCount: 0, destMissingSince: null },
        ]);
        const [next] = applyDestMissing([gone], updates);
        const again = trackDestMissing(
            [next],
            destination,
            'discord-to-fluxer',
            minutesAgo(-10)
        );
        assert.deepEqual(again, [
            { rowId: gone.id, destMissingCount: 2, destMissingSince: NOW },
        ]);
    });

    it('never counts tombstoned rows, the guild or overwrites', () => {
        const rows = [
            mapRow('channel', 'c1', 'f-x', { state: 'tombstoned' }),
            mapRow('guild', 'g', 'f-g'),
            mapRow('overwrite', 'o', 'f-o'),
        ];
        assert.deepEqual(
            trackDestMissing(rows, destination, 'discord-to-fluxer', NOW),
            []
        );
    });

    it('does not count a thread an incomplete thread list could hide', () => {
        const gapped = fluxerGuild({
            ...destination,
            threadGaps: ['f-forum'],
            privateThreadGaps: ['f-chan'],
        });
        const rows = [
            mapRow('thread', 't2', 'f-t2', {
                appliedFields: { parentId: 'f-forum' },
            }),
            mapRow('thread', 't3', 'f-t3', { appliedFields: {} }),
            mapRow('thread', 't4', 'f-t4', {
                appliedFields: { parentId: 'f-chan', private: true },
            }),
        ];
        assert.deepEqual(
            trackDestMissing(rows, gapped, 'discord-to-fluxer', NOW),
            []
        );
        assert.equal(
            trackDestMissing(rows, destination, 'discord-to-fluxer', NOW)
                .length,
            3
        );
    });

    it('treats a destination without channels as unhealthy', () => {
        assert.equal(destinationHealthy(destination), true);
        assert.equal(destinationHealthy(fluxerGuild({ channels: [] })), false);
        assert.equal(
            destinationHealthy({ ...destination, roles: [role('f-role')] }),
            false
        );
    });
});

describe('restoreCandidates', () => {
    const destination = fluxerGuild({
        channels: [channel('f-forum', { type: 15 })],
    });
    const candidates = (
        rows: MapRow[],
        missing = rows.map((r) => missingOf(r))
    ) => restoreCandidates(rows, missing, destination, SETTINGS, NOW);

    it('waits for both the check count and the time', () => {
        assert.deepEqual(
            candidates([missingRow('role', 'r', 'f-r', 2, 60)]),
            []
        );
        assert.deepEqual(
            candidates([missingRow('role', 'r', 'f-r', 5, 29)]),
            []
        );
        const ready = missingRow('role', 'r', 'f-r', 3, 30);
        assert.deepEqual(candidates([ready]), [ready]);
    });

    it('takes only active copies created by sync while Discord is the source', () => {
        const rows = [
            missingRow('role', 'r1', 'f-r1', 9, 99, { createdBySync: false }),
            missingRow('role', 'r2', 'f-r2', 9, 99, { state: 'archived' }),
            missingRow('thread', 't1', 'f-t1', 9, 99, {
                createdBySync: false,
                appliedFields: { parentId: 'f-forum' },
            }),
        ];
        assert.deepEqual(candidates(rows), []);
        const ready = missingRow('emoji', 'e', 'f-e', 9, 99);
        assert.deepEqual(
            restoreCandidates(
                [ready],
                [missingOf(ready)],
                destination,
                { ...SETTINGS, direction: 'fluxer-to-discord' },
                NOW
            ),
            []
        );
    });

    it('takes only copies the diff reports missing', () => {
        const ready = missingRow('channel', 'c', 'f-c', 9, 99);
        assert.deepEqual(candidates([ready], []), []);
        assert.deepEqual(
            candidates([ready], [{ ...missingOf(ready), destId: 'other' }]),
            []
        );
    });

    it('never takes @everyone, and leaves a thread to its missing channel', () => {
        const everyone = missingRow('role', 'd-guild', F_GUILD, 9, 99);
        const orphan = missingRow('thread', 't', 'f-t', 9, 99, {
            appliedFields: { parentId: 'f-gone' },
        });
        const kept = missingRow('thread', 't2', 'f-t2', 9, 99, {
            appliedFields: { parentId: 'f-forum' },
        });
        assert.deepEqual(candidates([everyone, orphan, kept]), [kept]);
    });

    it('sorts by kind, then by how long the copy is missing', () => {
        const t = missingRow('thread', 't', 'f-t', 9, 99, {
            appliedFields: { parentId: 'f-forum' },
        });
        const newer = missingRow('role', 'r1', 'f-r1', 9, 40);
        const older = missingRow('role', 'r2', 'f-r2', 9, 90);
        const cat = missingRow('category', 'k', 'f-k', 9, 99);
        assert.deepEqual(
            candidates([t, newer, cat, older]).map((r) => r.discordId),
            ['r2', 'r1', 'k', 't']
        );
    });
});

describe('massMissing', () => {
    const limits = { shrinkPercent: 10, shrinkMinObjects: 5 };
    const roles = (missing: number, total: number) =>
        Array.from({ length: total }, (_, i) =>
            mapRow('role', `r${i}`, `f-r${i}`, {
                destMissingCount: i < missing ? 1 : 0,
            })
        );

    it('passes up to the larger of the share and the floor', () => {
        assert.equal(massMissing(roles(5, 20), limits), null);
        assert.equal(massMissing(roles(10, 100), limits), null);
    });

    it('trips over the limit, whatever the creator', () => {
        const reason = massMissing(roles(6, 20), limits);
        assert.match(reason ?? '', /6 of 20 role copies are missing/);
        const adopted = roles(6, 20).map((r) => ({
            ...r,
            createdBySync: false,
        }));
        assert.notEqual(massMissing(adopted, limits), null);
    });

    it('does not count threads missing with their channel', () => {
        const rows = [
            mapRow('channel', 'c', 'f-c', { destMissingCount: 1 }),
            ...Array.from({ length: 30 }, (_, i) =>
                mapRow('thread', `t${i}`, `f-t${i}`, {
                    destMissingCount: 1,
                    appliedFields: { parentId: 'f-c' },
                })
            ),
        ];
        assert.equal(massMissing(rows, limits), null);
    });

    it('fails closed on limits out of range', () => {
        assert.notEqual(
            massMissing([], { shrinkPercent: 0, shrinkMinObjects: 5 }),
            null
        );
        assert.notEqual(
            massMissing([], { shrinkPercent: 10, shrinkMinObjects: -1 }),
            null
        );
    });
});

describe('restoreRoom', () => {
    it('is the cycle cap, less what the day has left', () => {
        assert.deepEqual(restoreRoom(0), {
            room: MAX_RESTORES_PER_CYCLE,
            reason: null,
        });
        assert.deepEqual(restoreRoom(MAX_RESTORES_PER_DAY - 3), {
            room: 3,
            reason: null,
        });
        const full = restoreRoom(MAX_RESTORES_PER_DAY);
        assert.equal(full.room, 0);
        assert.match(full.reason ?? '', /daily cap/);
        assert.equal(restoreRoom(-1).room, 0);
    });
});

describe('allowedRestores', () => {
    const a = restoreItem(mapRow('role', 'r1', 'f-r1', { id: 'a' }), 'A');
    const b = restoreItem(mapRow('role', 'r2', 'f-r2', { id: 'b' }), 'B');

    it('allows every planned restore without a hold', () => {
        assert.deepEqual(allowedRestores([a, b], null, null), [a, b]);
    });

    it('allows only what an admin approved while held', () => {
        assert.deepEqual(allowedRestores([a, b], 'held', null), []);
        assert.deepEqual(
            allowedRestores([a, b], 'held', {
                restores: [a],
                restoreHold: null,
            }),
            []
        );
        assert.deepEqual(
            allowedRestores([a, b], 'held', {
                restores: [a],
                restoreHold: 'held',
            }),
            [a]
        );
    });
});

describe('childThreads', () => {
    it('finds the copies sync made in a channel, never mirrored ones', () => {
        const source = discordGuild({
            channels: [channel('forum', { type: 15 })],
            threads: [thread('t1', 'forum')],
        });
        const byApplied = mapRow('thread', 't2', 'f-t2', {
            appliedFields: { parentId: 'f-forum' },
        });
        const bySource = mapRow('thread', 't1', 'f-t1');
        const mirror = mapRow('thread', 't3', 'f-t3', {
            createdBySync: false,
            appliedFields: { parentId: 'f-forum' },
        });
        const elsewhere = mapRow('thread', 't4', 'f-t4', {
            appliedFields: { parentId: 'f-other' },
        });
        const item = restoreItem(mapRow('channel', 'forum', 'f-forum'), 'f');
        assert.deepEqual(
            childThreads(
                [byApplied, bySource, mirror, elsewhere],
                item,
                source
            ),
            [byApplied, bySource]
        );
    });
});

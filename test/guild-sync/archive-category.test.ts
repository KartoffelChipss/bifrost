import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARCHIVE_KEY, applyPlan } from '../../src/guild-sync/apply';
import type { MapRow, PlanOp } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import type { ChannelSnap } from '../../src/guild-sync/snapshot';
import { archivedName } from '../../src/guild-sync/writes';
import { createRecordingLogger } from '../addons/fakes';
import { FakeGuild } from './fake-guild';
import { FakeAssets, FakeStore } from './fake-store';
import { channel, discordGuild, fluxerGuild, mapRow } from './fixtures';

const archive = (id: string): PlanOp => ({
    op: 'archive',
    kind: 'channel',
    sourceId: id,
    destId: `f${id}`,
});

function plan(ops: PlanOp[]): Plan {
    return {
        id: 'p1',
        guildLinkId: 'link-1',
        direction: 'discord-to-fluxer',
        status: 'dry-run',
        body: {
            ops,
            deferred: [],
            findings: [],
            needsApproval: false,
            approvalReason: null,
        },
        abortReason: null,
    };
}

async function run(channels: ChannelSnap[], rows: MapRow[], ops: PlanOp[]) {
    const guild = new FakeGuild(fluxerGuild({ channels }));
    const store = new FakeStore();
    store.rows = rows;
    const result = await applyPlan(
        {
            plan: plan(ops),
            source: discordGuild(),
            destination: guild.snapshot,
            rows,
        },
        {
            store,
            writer: guild,
            assets: new FakeAssets(),
            links: null,
            threads: null,
            canWrite: () => true,
            pause: async () => undefined,
            now: () => new Date(),
            logger: createRecordingLogger(),
        }
    );
    return { guild, store, result };
}

const archiveRows = (store: FakeStore) =>
    store.rows.filter(
        (r) => typeof r.appliedFields?.[ARCHIVE_KEY] === 'number'
    );

describe('the archive category', () => {
    it('never uses a user category of the same name, and owns its own', async () => {
        const { guild, store, result } = await run(
            [
                channel('user-cat', { type: 4, name: 'archived-sync' }),
                channel('f1', { name: 'old' }),
            ],
            [mapRow('channel', '1', 'f1')],
            [archive('1')]
        );
        assert.equal(result.failed, 0);
        const [row] = archiveRows(store);
        assert.ok(row?.fluxerId && row.fluxerId !== 'user-cat');
        assert.equal(row.discordId, null);
        assert.equal(row.createdBySync, true);
        const moved = guild.snapshot.channels.find((c) => c.id === 'f1');
        assert.equal(moved?.parentId, row.fluxerId);
    });

    it('opens a numbered archive category once one is full', async () => {
        const full = Array.from({ length: 50 }, (_, i) =>
            channel(`a${i}`, { parentId: 'arch-1' })
        );
        const { guild, store } = await run(
            [
                channel('arch-1', { type: 4, name: 'archived-sync' }),
                ...full,
                channel('f1'),
            ],
            [
                mapRow('category', '', 'arch-1', {
                    discordId: null,
                    appliedFields: { [ARCHIVE_KEY]: 1 },
                }),
                mapRow('channel', '1', 'f1'),
            ],
            [archive('1')]
        );
        const rows = archiveRows(store);
        assert.equal(rows.length, 2);
        const second = guild.snapshot.channels.find(
            (c) => c.id === rows[1].fluxerId
        );
        assert.equal(second?.name, 'archived-sync-2');
    });

    it('archives a name once, however often an archive is retried', () => {
        const once = archivedName('general', 100);
        assert.equal(once, '[archived] general');
        assert.equal(archivedName(once, 100), once);
    });
});

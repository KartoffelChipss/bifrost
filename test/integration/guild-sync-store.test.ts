import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { EMPTY_BODY } from '../../src/guild-sync/plan';
import { stableJson } from '../../src/guild-sync/snapshot';
import { PostgresGuildSyncStore } from '../../src/guild-sync/store';
import { createRecordingLogger } from '../addons/fakes';
import { channel, discordGuild } from '../guild-sync/fixtures';

/**
 * Runs the guild-sync store against a real Postgres (BF_TEST_POSTGRES_URL).
 * It creates its own database next to the one in the URL, so it can run
 * beside the other integration tests, which reset the public schema.
 */
const url = process.env.BF_TEST_POSTGRES_URL;
const DATABASE = 'bifrost_test_guild_sync';

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

describe('PostgresGuildSyncStore', { skip: !url }, () => {
    let db: Sequelize;
    let store: PostgresGuildSyncStore;
    let linkId: string;

    before(async () => {
        const admin = new Sequelize(url ?? '', { logging: false });
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await admin.query(`CREATE DATABASE ${DATABASE}`);
        await admin.close();
        db = new Sequelize(databaseUrl(url ?? '', DATABASE), {
            logging: false,
        });
        await db.getQueryInterface().createTable('guild_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            discordGuildId: { type: DataTypes.STRING },
            fluxerGuildId: { type: DataTypes.STRING },
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        await runAddonMigrations(db, createRecordingLogger());
        linkId = randomUUID();
        await db.query(
            `INSERT INTO guild_links (id, "discordGuildId", "fluxerGuildId", "createdAt") VALUES ($1, 'd', 'f', now())`,
            { bind: [linkId] }
        );
        store = new PostgresGuildSyncStore(db);
    });

    after(() => db.close());

    it('creates settings from the migration defaults', async () => {
        const settings = await store.loadSettings(linkId);
        assert.equal(settings.mode, 'dry-run');
        assert.equal(settings.killSwitch, false);
        assert.equal(settings.deleteBudgetPerCycle, 3);
        assert.deepEqual(await store.loadSettings(linkId), settings);
    });

    it('lets only one holder take the leader lock', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        const first = store.withLeaderLock('a', () => held);
        // Give the first transaction time to take the lock.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const second = await store.withLeaderLock('b', async () => 'ran');
        release();
        assert.deepEqual(await first, { ran: true, value: undefined });
        assert.deepEqual(second, { ran: false });
        assert.deepEqual(await store.withLeaderLock('c', async () => 1), {
            ran: true,
            value: 1,
        });
    });

    it('round-trips a snapshot through JSONB', async () => {
        const snapshot = discordGuild({ channels: [channel('c1')] });
        await store.saveSnapshot(linkId, snapshot, true, new Date());
        const loaded = await store.lastSnapshot(linkId, 'discord', true);
        assert.ok(loaded);
        assert.equal(stableJson(loaded), stableJson(snapshot));
    });

    it('prunes old snapshots but keeps the newest healthy one', async () => {
        const old = new Date('2020-01-01T00:00:00Z');
        await store.saveSnapshot(
            linkId,
            discordGuild({ name: 'old' }),
            true,
            old
        );
        await store.pruneSnapshots(new Date('2999-01-01T00:00:00Z'));
        const [rows] = await db.query(`SELECT side FROM ${TABLES.snapshots}`);
        assert.equal(rows.length, 1);
    });

    it('updates missing counters and reads map rows back', async () => {
        const rowId = randomUUID();
        await db.query(
            `INSERT INTO ${TABLES.objectMap} (id, "guildLinkId", kind, "discordId", "fluxerId", "createdBySync", "createdAt", "updatedAt")
             VALUES ($1, $2, 'channel', 'c1', 'f1', true, now(), now())`,
            { bind: [rowId, linkId] }
        );
        const since = new Date('2026-11-01T00:00:00Z');
        await store.saveMissing(
            [{ rowId, missingCount: 2, missingSince: since }],
            new Date()
        );
        const [row] = await store.loadObjectMap(linkId);
        assert.equal(row.missingCount, 2);
        assert.equal(row.missingSince?.toISOString(), since.toISOString());
    });

    it('saves a plan and counts no removals without audit rows', async () => {
        await store.savePlan(
            {
                id: randomUUID(),
                guildLinkId: linkId,
                direction: 'discord-to-fluxer',
                status: 'dry-run',
                body: EMPTY_BODY,
                abortReason: null,
            },
            new Date()
        );
        const [plans] = await db.query(`SELECT status FROM ${TABLES.plans}`);
        assert.deepEqual(plans, [{ status: 'dry-run' }]);
        assert.equal(await store.removalsSince(linkId, new Date(0)), 0);
    });

    it('records ownership, applied fields and audit rows', async () => {
        const now = new Date();
        const row = await store.insertMapping(
            {
                guildLinkId: linkId,
                kind: 'role',
                discordId: 'd-role',
                fluxerId: 'f-role',
                createdBySync: true,
                appliedFields: { name: 'Mods', permissions: '8' },
            },
            now
        );
        await store.saveApplied(
            row.id,
            { name: 'Mods', permissions: '2' },
            now
        );
        const loaded = (await store.loadObjectMap(linkId)).find(
            (r) => r.id === row.id
        );
        assert.deepEqual(loaded?.appliedFields, {
            name: 'Mods',
            permissions: '2',
        });
        assert.equal(loaded?.createdBySync, true);
        // The same destination object cannot be owned twice.
        await assert.rejects(
            store.insertMapping(
                {
                    guildLinkId: linkId,
                    kind: 'role',
                    discordId: 'other',
                    fluxerId: 'f-role',
                    createdBySync: true,
                    appliedFields: {},
                },
                now
            )
        );
        const entry = {
            planId: randomUUID(),
            guildLinkId: linkId,
            kind: 'role' as const,
            sourceId: 'd-role',
            destId: 'f-role',
            before: null,
            after: { name: 'Mods' },
        };
        await store.audit({ ...entry, op: 'create', result: 'ok' }, now);
        await store.audit({ ...entry, op: 'archive', result: 'failed' }, now);
        await store.audit({ ...entry, op: 'archive', result: 'ok' }, now);
        // Only successful removals count against the delete budget.
        assert.equal(await store.removalsSince(linkId, new Date(0)), 1);
    });

    it('changes the mode, the kill switch and a plan status', async () => {
        const now = new Date();
        await store.setMode(linkId, 'apply', now);
        await store.setKillSwitch(linkId, true, now);
        const settings = await store.loadSettings(linkId);
        assert.equal(settings.mode, 'apply');
        assert.equal(settings.killSwitch, true);
        await assert.rejects(
            store.setMode(linkId, 'yolo' as 'apply', now),
            'the CHECK constraint refuses an unknown mode'
        );
        const id = randomUUID();
        await store.savePlan(
            {
                id,
                guildLinkId: linkId,
                direction: 'discord-to-fluxer',
                status: 'dry-run',
                body: EMPTY_BODY,
                abortReason: null,
            },
            new Date(now.getTime() + 60_000)
        );
        await store.setPlanStatus(id, 'aborted', 'apply: 1 failed', now);
        const last = await store.lastPlan(linkId);
        assert.equal(last?.id, id);
        assert.equal(last?.status, 'aborted');
        assert.equal(last?.abortReason, 'apply: 1 failed');
        assert.deepEqual(last?.body, EMPTY_BODY);
    });

    it('stores the admin channel, an approval and a row state', async () => {
        const now = new Date();
        const planId = randomUUID();
        await store.setAdminChannel(linkId, '123', now);
        await store.setApprovedPlan(linkId, planId, now);
        const set = await store.loadSettings(linkId);
        assert.equal(set.adminChannelId, '123');
        assert.equal(set.approvedPlanId, planId);
        await store.setApprovedPlan(linkId, null, now);
        await store.setAdminChannel(linkId, null, now);
        const cleared = await store.loadSettings(linkId);
        assert.equal(cleared.approvedPlanId, null);
        assert.equal(cleared.adminChannelId, null);
        assert.equal(await store.getPlan(planId), null);

        const row = await store.insertMapping(
            {
                guildLinkId: linkId,
                kind: 'emoji',
                discordId: 'd-emoji',
                fluxerId: 'f-emoji',
                createdBySync: true,
                appliedFields: { name: 'wave' },
            },
            now
        );
        await store.setRowState(row.id, 'archived', now);
        const loaded = (await store.loadObjectMap(linkId)).find(
            (r) => r.id === row.id
        );
        assert.equal(loaded?.state, 'archived');
    });

    it('finds a thread pair and keeps relayed thread messages', async () => {
        const now = new Date();
        await store.insertMapping(
            {
                guildLinkId: linkId,
                kind: 'thread',
                discordId: 'd-post',
                fluxerId: 'f-post',
                createdBySync: true,
                appliedFields: { name: 'Patch notes' },
            },
            now
        );
        assert.deepEqual(await store.findThreadPair('fluxer', 'f-post'), {
            guildLinkId: linkId,
            discordId: 'd-post',
            fluxerId: 'f-post',
        });
        assert.equal(await store.findThreadPair('discord', 'unknown'), null);

        const message = {
            guildLinkId: linkId,
            discordThreadId: 'd-post',
            fluxerThreadId: 'f-post',
            discordMessageId: 'dm1',
            fluxerMessageId: 'fm1',
        };
        await store.saveThreadMessage(message, now);
        assert.deepEqual(
            await store.findThreadMessage('fluxer', 'fm1'),
            message
        );
        await assert.rejects(store.saveThreadMessage(message, now));
        await store.deleteThreadMessage('discord', 'dm1');
        assert.equal(await store.findThreadMessage('discord', 'dm1'), null);
    });
});

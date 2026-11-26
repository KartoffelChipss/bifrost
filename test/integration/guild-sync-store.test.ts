import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DataTypes, QueryTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { EMPTY_BODY } from '../../src/guild-sync/plan';
import { stableJson } from '../../src/guild-sync/snapshot';
import {
    HISTORY_LOCK_KEY,
    PLANS_KEPT_PER_LINK,
    PostgresGuildSyncStore,
} from '../../src/guild-sync/store';
import { PostgresHistoryStore } from '../../src/history/store';
import { PostgresIdentityStore } from '../../src/identity/store';
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

    it('keeps history jobs, imported messages and opt-outs', async () => {
        const now = new Date();
        const history = new PostgresHistoryStore(db);
        await history.ensureJob(linkId, 'thread', 'd-post', 'd-forum', now);
        await history.ensureJob(linkId, 'thread', 'd-post', 'd-forum', now);
        const [job] = await history.listJobs(linkId);
        assert.equal((await history.listJobs(linkId)).length, 1);
        assert.equal(job.status, 'pending');
        // Not mapped yet, but the active pair f-post names its thread.
        assert.equal(await history.threadImporting('f-post'), true);
        assert.equal(await history.threadImporting('f-other'), false);
        await history.updateJob(
            job.id,
            {
                fluxerId: 'f-post',
                status: 'importing',
                cutoffId: '99',
                importWebhook: { id: 'w', token: 't' },
            },
            now
        );
        assert.equal(await history.threadImporting('f-post'), true);
        const updated = await history.getJob(job.id);
        assert.deepEqual(updated?.importWebhook, { id: 'w', token: 't' });
        const copy = {
            discordMessageId: 'dm1',
            jobId: job.id,
            discordAuthorId: 'author',
            fluxerMessageId: null,
            fluxerTargetId: 'f-post',
            inThread: true,
            webhookId: 'w',
        };
        await history.startMessage(copy, now);
        assert.equal(
            (await history.unfinishedMessage(job.id))?.discordMessageId,
            'dm1'
        );
        await history.finishMessage('dm1', 'fm1');
        assert.equal(await history.unfinishedMessage(job.id), null);
        assert.equal(
            (await history.importedByFluxerId('fm1'))?.discordAuthorId,
            'author'
        );
        await assert.rejects(history.startMessage(copy, now));
        await history.setOptOut('author', true, now);
        assert.equal(await history.isOptedOut('author'), true);
        await history.setOptOut('author', false, now);
        assert.equal(await history.isOptedOut('author'), false);
        await history.updateJob(job.id, { status: 'done' }, now);
        assert.equal(await history.threadImporting('f-post'), false);
    });

    it('tells history and the thread relay what the other copied', async () => {
        const now = new Date();
        const history = new PostgresHistoryStore(db);
        const [job] = await history.listJobs(linkId);
        assert.equal(
            (await history.importedByDiscordId('dm1'))?.fluxerMessageId,
            'fm1'
        );
        assert.equal(await history.importedByDiscordId('none'), null);
        await store.saveThreadMessage(
            {
                guildLinkId: linkId,
                discordThreadId: 'd-post',
                fluxerThreadId: 'f-post',
                discordMessageId: '120',
                fluxerMessageId: 'f120',
            },
            now
        );
        assert.equal(await history.relayedInThread('120'), true);
        assert.equal(await history.relayedInThread('121'), false);
        // The finished job's cutoff is 99: replies up to it are covered.
        assert.equal(await store.historyCovers('d-post', 'dm1'), true);
        assert.equal(await store.historyCovers('d-post', '98'), true);
        assert.equal(await store.historyCovers('d-post', '100'), false);
        await history.updateJob(job.id, { status: 'failed' }, now);
        assert.equal(await store.historyCovers('d-post', '98'), false);
    });

    it('keeps account links, codes, pending links and failures', async () => {
        const identity = new PostgresIdentityStore(db);
        const now = new Date();
        const later = new Date(now.getTime() + 60_000);
        await identity.saveCode('hash', 'discord', 'd1', later);
        assert.equal(await identity.takeCode('hash', 'fluxer', now), null);
        assert.equal(await identity.takeCode('hash', 'discord', now), 'd1');
        assert.equal(await identity.takeCode('hash', 'discord', now), null);
        await identity.savePending({
            discordUserId: 'd1',
            fluxerUserId: 'f1',
            confirmSide: 'discord',
            confirmUserId: 'd1',
            expiresAt: later,
        });
        assert.equal(await identity.takePending('fluxer', 'f1', now), null);
        const pending = await identity.takePending('discord', 'd1', now);
        assert.equal(pending?.fluxerUserId, 'f1');
        assert.equal(
            await identity.savePair(
                { discordUserId: 'd1', fluxerUserId: 'f1' },
                now
            ),
            true
        );
        assert.equal(
            await identity.savePair(
                { discordUserId: 'd2', fluxerUserId: 'f1' },
                now
            ),
            false
        );
        assert.deepEqual(await identity.pairFor('fluxer', 'f1'), {
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });
        assert.equal((await identity.listPairs()).length, 1);
        await identity.deletePair('fluxer', 'f1');
        assert.equal(await identity.pairFor('discord', 'd1'), null);
        await identity.recordFailure('fluxer', 'f1', now);
        await identity.recordFailure('fluxer', 'f1', now);
        assert.equal(
            await identity.failuresSince('fluxer', 'f1', new Date(0)),
            2
        );
        assert.equal(await identity.failuresSince('fluxer', 'f1', later), 0);
    });

    it('purges used and expired codes, pending links and old failures', async () => {
        const identity = new PostgresIdentityStore(db);
        const now = new Date();
        const past = new Date(now.getTime() - 60_000);
        const later = new Date(now.getTime() + 60_000);
        await identity.saveCode('old', 'discord', 'p1', past);
        await identity.saveCode('used', 'discord', 'p2', later);
        await identity.takeCode('used', 'discord', now);
        await identity.saveCode('live', 'discord', 'p3', later);
        await identity.savePending({
            discordUserId: 'p1',
            fluxerUserId: 'q1',
            confirmSide: 'discord',
            confirmUserId: 'p1',
            expiresAt: past,
        });
        await identity.recordFailure('discord', 'p1', past);
        await identity.recordFailure('discord', 'p1', later);
        await identity.purgeExpired(now, now);
        const codes = await db.query<{ codeHash: string }>(
            `SELECT "codeHash" FROM ${TABLES.identityCodes} WHERE "userId" LIKE 'p%'`,
            { type: QueryTypes.SELECT }
        );
        assert.deepEqual(
            codes.map((row) => row.codeHash),
            ['live']
        );
        assert.equal(await identity.takePending('discord', 'p1', past), null);
        assert.equal(
            await identity.failuresSince('discord', 'p1', new Date(0)),
            1
        );
    });

    it('takes a separate lock per add-on loop', async () => {
        const inner = await store.withLeaderLock('a', () =>
            store.withLeaderLock('b', async () => 'nested', HISTORY_LOCK_KEY)
        );
        assert.deepEqual(inner, {
            ran: true,
            value: { ran: true, value: 'nested' },
        });
    });

    it('prunes tombstoned map rows and keeps the rest', async () => {
        const now = new Date();
        const mapping = (discordId: string) =>
            store.insertMapping(
                {
                    guildLinkId: linkId,
                    kind: 'role',
                    discordId,
                    fluxerId: `f-${discordId}`,
                    createdBySync: true,
                    appliedFields: {},
                },
                now
            );
        const gone = await mapping('gone-role');
        const kept = await mapping('kept-role');
        await store.setRowState(gone.id, 'tombstoned', now);
        const later = new Date(now.getTime() + 1000);
        assert.equal(await store.pruneTombstoned(later), 1);
        const ids = (await store.loadObjectMap(linkId)).map((r) => r.id);
        assert.ok(!ids.includes(gone.id));
        assert.ok(ids.includes(kept.id));
    });

    it('reads back create intents from the audit log', async () => {
        const at = new Date();
        await store.audit(
            {
                planId: randomUUID(),
                guildLinkId: linkId,
                op: 'create-intent',
                kind: 'channel',
                sourceId: 'src-1',
                destId: null,
                before: null,
                after: { name: 'general' },
                result: 'intent',
            },
            at
        );
        const intents = await store.createIntents(
            linkId,
            new Date(at.getTime() - 1000)
        );
        assert.deepEqual(
            intents.map((i) => [i.kind, i.sourceId, i.name]),
            [['channel', 'src-1', 'general']]
        );
        assert.equal(intents[0].at.getTime(), at.getTime());
        assert.equal(await store.removalsSince(linkId, new Date(0)), 1);
    });

    it('prunes old plans but keeps recent, pending and approved ones', async () => {
        const link = randomUUID();
        await db.query(
            `INSERT INTO guild_links (id, "discordGuildId", "fluxerGuildId", "createdAt") VALUES ($1, 'd2', 'f2', now())`,
            { bind: [link] }
        );
        const old = new Date('2020-01-01T00:00:00Z');
        const save = async (
            status: 'dry-run' | 'pending-approval',
            at: Date
        ) => {
            const id = randomUUID();
            await store.savePlan(
                {
                    id,
                    guildLinkId: link,
                    direction: 'discord-to-fluxer',
                    status,
                    body: EMPTY_BODY,
                    abortReason: null,
                },
                at
            );
            return id;
        };
        const approved = await save('pending-approval', old);
        await store.setApprovedPlan(link, approved, new Date());
        const stalePending = await save('pending-approval', old);
        const pending = await save(
            'pending-approval',
            new Date(old.getTime() + 1)
        );
        const stale: string[] = [];
        for (let i = 0; i < PLANS_KEPT_PER_LINK + 3; i++) {
            stale.push(
                await save('dry-run', new Date(old.getTime() + 100 + i))
            );
        }
        const pruned = await store.prunePlans(new Date('2021-01-01T00:00:00Z'));
        assert.ok(pruned >= 4);
        assert.ok(await store.getPlan(approved));
        assert.ok(await store.getPlan(pending));
        assert.equal(await store.getPlan(stalePending), null);
        // The newest plans stay; the oldest dry-runs past the limit go.
        assert.equal(await store.getPlan(stale[0]), null);
        assert.ok(await store.getPlan(stale[stale.length - 1]));
        await store.setApprovedPlan(link, null, new Date());
    });

    it('turns drift enforcement on and off', async () => {
        assert.equal((await store.loadSettings(linkId)).enforceDrift, false);
        await store.setEnforceDrift(linkId, true, new Date());
        assert.equal((await store.loadSettings(linkId)).enforceDrift, true);
        await store.setEnforceDrift(linkId, false, new Date());
        assert.equal((await store.loadSettings(linkId)).enforceDrift, false);
    });
    it('saves, reads and clears the status message place', async () => {
        assert.equal(await store.loadStatusMessage(linkId), null);
        const before = await store.loadSettings(linkId);
        const ref = { channelId: 'admin-1', messageId: 'msg-1' };
        await store.saveStatusMessage(linkId, ref);
        assert.deepEqual(await store.loadStatusMessage(linkId), ref);
        // The place is not a setting: loading settings is unchanged.
        assert.deepEqual(await store.loadSettings(linkId), before);
        await store.saveStatusMessage(linkId, null);
        assert.equal(await store.loadStatusMessage(linkId), null);
    });

    it('counts active map rows by kind', async () => {
        const otherLink = randomUUID();
        await db.query(
            `INSERT INTO guild_links (id, "discordGuildId", "fluxerGuildId", "createdAt") VALUES ($1, 'd2', 'f2', now())`,
            { bind: [otherLink] }
        );
        assert.deepEqual(await store.countMapped(otherLink), {});
        const now = new Date();
        const mapping = (kind: 'role' | 'channel', discordId: string) =>
            store.insertMapping(
                {
                    guildLinkId: otherLink,
                    kind,
                    discordId,
                    fluxerId: `f-${discordId}`,
                    createdBySync: true,
                    appliedFields: {},
                },
                now
            );
        await mapping('role', 'count-r1');
        await mapping('role', 'count-r2');
        await mapping('channel', 'count-c1');
        const archived = await mapping('channel', 'count-c2');
        await store.setRowState(archived.id, 'archived', now);
        assert.deepEqual(await store.countMapped(otherLink), {
            role: 2,
            channel: 1,
        });
    });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { PostgresMentionStore } from '../../src/history/mentionStore';
import { PostgresHistoryStore } from '../../src/history/store';
import { createRecordingLogger } from '../addons/fakes';

/** Mention tables (migration 00013) and their queries, on real Postgres. */
const url = process.env.BF_TEST_POSTGRES_URL;
const DATABASE = 'bifrost_test_history_mentions';
const LINKED_AT = new Date('2026-11-25T11:00:00Z');
const NOW = new Date('2026-11-25T12:00:00Z');

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

describe('history mention tables on Postgres', { skip: !url }, () => {
    let db: Sequelize;
    let linkId: string;
    let jobId: string;
    let history: PostgresHistoryStore;
    let mentions: PostgresMentionStore;

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
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        await runAddonMigrations(db, createRecordingLogger());
        history = new PostgresHistoryStore(db);
        mentions = new PostgresMentionStore(db);
    });

    beforeEach(async () => {
        await db.query(`TRUNCATE guild_links, ${TABLES.identityLinks} CASCADE`);
        linkId = randomUUID();
        jobId = randomUUID();
        await db.query(
            `INSERT INTO guild_links (id, "createdAt") VALUES ($1, now())`,
            { bind: [linkId] }
        );
        await db.query(
            `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", status, "createdAt", "updatedAt")
             VALUES ($1, $2, 'channel', '10', 'done', now(), now())`,
            { bind: [jobId, linkId] }
        );
    });

    after(() => db.close());

    /** A sent copy of Discord message `id`; unsent when `sent` is false. */
    async function copy(id: string, sent = true) {
        await history.startMessage(
            {
                discordMessageId: id,
                jobId,
                discordAuthorId: 'author',
                fluxerMessageId: null,
                fluxerTargetId: 'f10',
                inThread: false,
                webhookId: 'w',
                contentHash: 'h',
            },
            NOW
        );
        if (sent) await history.finishMessage(id, `copy-${id}`);
    }

    const link = (user: string, at = LINKED_AT) =>
        db.query(
            `INSERT INTO ${TABLES.identityLinks} ("discordUserId", "fluxerUserId", "linkedAt") VALUES ($1, $2, $3)
             ON CONFLICT ("discordUserId") DO UPDATE SET "linkedAt" = EXCLUDED."linkedAt"`,
            { bind: [user, `f${user}`, at] }
        );

    const fixupOf = async (user: string) =>
        (
            await mentions.dueFixups(
                linkId,
                ['pending', 'previewed', 'done'],
                new Date(8.64e15),
                10
            )
        ).find((f) => f.discordUserId === user);

    it('starts every copy unrecorded, and records and replaces mentions', async () => {
        await copy('11');
        await copy('12', false);
        assert.deepEqual(await mentions.scanJobs(linkId, 10), [jobId]);
        await history.recordMentions('11', ['500', '501', '500', 'x']);
        await history.recordMentions('11', ['502', '500']);
        const [rows] = await db.query(
            `SELECT "discordUserId" FROM ${TABLES.historyMentions} ORDER BY 1`
        );
        assert.deepEqual(rows, [
            { discordUserId: '500' },
            { discordUserId: '502' },
        ]);
        // The unsent copy is not for the backfill until it is sent.
        assert.equal(await mentions.scanLeft(linkId), false);
        await history.finishMessage('12', 'copy-12');
        assert.equal(await mentions.scanLeft(linkId), true);
    });

    it('lists unrecorded copies in snowflake order and settles them', async () => {
        for (const id of ['100', '9', '1000', '20']) await copy(id);
        await history.recordMentions('20', []);
        const page = await mentions.unscanned(jobId, 2);
        assert.deepEqual(
            page.map((c) => c.discordMessageId),
            ['9', '100']
        );
        await mentions.recordScan(
            linkId,
            [
                { discordMessageId: '9', discordUserIds: ['500'] },
                { discordMessageId: '100', discordUserIds: [] },
            ],
            NOW
        );
        assert.deepEqual(
            (await mentions.unscanned(jobId, 10)).map(
                (c) => c.discordMessageId
            ),
            ['1000']
        );
        await mentions.abandonScan(jobId);
        assert.equal(await mentions.scanLeft(linkId), false);
        assert.deepEqual(await mentions.scanJobs(linkId, 10), []);
    });

    it('finds copies by mentioned user after a snowflake, oldest first', async () => {
        for (const id of ['9', '100', '20', '1000']) {
            await copy(id);
            await history.recordMentions(id, id === '20' ? ['501'] : ['500']);
        }
        const all = await mentions.copiesMentioning(linkId, '500', '0', 10);
        assert.deepEqual(
            all.map((c) => c.discordMessageId),
            ['9', '100', '1000']
        );
        assert.equal(all[0]?.fluxerMessageId, 'copy-9');
        const later = await mentions.copiesMentioning(linkId, '500', '99', 1);
        assert.deepEqual(
            later.map((c) => c.discordMessageId),
            ['100']
        );
        const [indexes] = await db.query(
            `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
            { bind: [TABLES.historyMentions, `${TABLES.historyMentions}_user`] }
        );
        assert.match(
            JSON.stringify(indexes),
            /\(\\"discordUserId\\", \\"discordMessageId\\"\)/
        );
    });

    it('drops a copy mentions with it', async () => {
        await copy('11');
        await history.recordMentions('11', ['500']);
        await history.dropMessage('11');
        const [rows] = await db.query(
            `SELECT count(*)::int AS n FROM ${TABLES.historyMentions}`
        );
        assert.deepEqual(rows, [{ n: 0 }]);
    });

    it('starts fix-ups for linked members, keeps progress, restarts on a new link', async () => {
        await link('500');
        await link('600');
        const notBefore = new Date(NOW.getTime() + 60_000);
        assert.equal(
            await mentions.ensureFixups([linkId], '500', notBefore, NOW),
            1
        );
        assert.equal(
            await mentions.ensureFixups([linkId], null, notBefore, NOW),
            1
        );
        assert.deepEqual(
            await mentions.dueFixups(linkId, ['pending'], NOW, 10),
            []
        );
        const due = await mentions.dueFixups(
            linkId,
            ['pending'],
            notBefore,
            10
        );
        assert.deepEqual(
            due.map((f) => [f.discordUserId, f.status, f.doneTo]),
            [
                ['500', 'pending', '0'],
                ['600', 'pending', '0'],
            ]
        );
        const first = due[0];
        assert.ok(first);
        await mentions.saveFixup(
            first,
            { status: 'pending', doneTo: '42', changed: 3, failures: 0 },
            NOW
        );
        assert.equal(
            await mentions.ensureFixups([linkId], null, notBefore, NOW),
            0
        );
        assert.equal((await fixupOf('500'))?.doneTo, '42');
        await link('500', new Date('2026-11-25T11:30:00Z'));
        // Stale progress from the old link is not saved over the new one.
        await mentions.saveFixup(
            first,
            { status: 'done', doneTo: '99', changed: 4, failures: 0 },
            NOW
        );
        assert.equal(await fixupOf('500'), undefined);
        const [kept] = await db.query(
            `SELECT status, "doneTo" FROM ${TABLES.mentionFixups} WHERE "discordUserId" = '500'`
        );
        assert.deepEqual(kept, [{ status: 'pending', doneTo: '42' }]);
        assert.equal(
            await mentions.ensureFixups([linkId], '500', notBefore, NOW),
            1
        );
        const fresh = await fixupOf('500');
        assert.deepEqual([fresh?.doneTo, fresh?.changed], ['0', 0]);
    });

    it('skips a member who unlinked, and moves back a fix-up the backfill outran', async () => {
        await link('500');
        await mentions.ensureFixups([linkId], null, NOW, NOW);
        const fixup = await fixupOf('500');
        assert.ok(fixup);
        await mentions.saveFixup(
            fixup,
            { status: 'done', doneTo: '5000', changed: 2, failures: 0 },
            NOW
        );
        for (const id of ['120', '1000']) await copy(id);
        await mentions.recordScan(
            linkId,
            [
                { discordMessageId: '1000', discordUserIds: ['500'] },
                { discordMessageId: '120', discordUserIds: ['500', '700'] },
            ],
            NOW
        );
        const moved = await fixupOf('500');
        assert.deepEqual(
            [moved?.status, moved?.doneTo, moved?.changed],
            ['pending', '119', 0]
        );
        await db.query(`DELETE FROM ${TABLES.identityLinks}`);
        assert.equal(await fixupOf('500'), undefined);
    });

    it('rejects a fix-up with an unknown status or a negative count', async () => {
        await link('500');
        await mentions.ensureFixups([linkId], null, NOW, NOW);
        await assert.rejects(
            db.query(`UPDATE ${TABLES.mentionFixups} SET status = 'yolo'`)
        );
        await assert.rejects(
            db.query(`UPDATE ${TABLES.mentionFixups} SET changed = -1`)
        );
    });
});

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { parseRawMessage } from '../../src/archive/parse';
import {
    FILE_RETRY_MS,
    MAX_CHANNEL_FAILURES,
    PostgresArchiveStore,
} from '../../src/archive/store';
import type { FileRef, RawMessage } from '../../src/archive/types';
import { createRecordingLogger } from '../addons/fakes';
import { attachment, rawMessage } from '../archive/fakes';

/** The archive tables (migration 00015) and their queries, on Postgres. */
const url = process.env.BF_TEST_POSTGRES_URL;
const DATABASE = 'bifrost_test_archive';
const NOW = new Date('2026-11-26T12:00:00Z');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

function message(id: string, fields: Record<string, unknown> = {}): RawMessage {
    const parsed = parseRawMessage(rawMessage(id, fields));
    assert.ok(parsed);
    return parsed;
}

const file = (sourceId: string, messageId: string): FileRef => ({
    kind: 'attachment',
    sourceId,
    messageId,
    filename: `${sourceId}.png`,
    size: 10,
    contentType: 'image/png',
    url: `https://cdn/${sourceId}`,
});

describe('archive tables on Postgres', { skip: !url }, () => {
    let db: Sequelize;
    let store: PostgresArchiveStore;

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
        store = new PostgresArchiveStore(db);
    });

    beforeEach(async () => {
        await db.query(
            `TRUNCATE ${TABLES.archiveChannels}, ${TABLES.archiveMessages}, ${TABLES.archiveMembers}, ${TABLES.archiveFiles}, ${TABLES.historyOptOuts}`
        );
    });

    after(() => db.close());

    it('adds channels once, records progress, and stops after repeated failures', async () => {
        const target = {
            channelId: '200',
            guildId: '100',
            kind: 'channel' as const,
            parentId: null,
        };
        await store.ensureChannels([target], NOW);
        await store.advance('200', '15', 3, NOW);
        await store.ensureChannels([target], NOW);
        let [row] = await store.channels('100');
        assert.deepEqual(
            [row?.afterId, row?.messages, row?.status],
            ['15', 3, 'walking']
        );
        await store.caughtUp('200', NOW);
        await store.advance('200', '16', 1, NOW);
        [row] = await store.channels('100');
        assert.deepEqual(
            [row?.status, row?.walkedAt?.toISOString()],
            ['current', NOW.toISOString()]
        );
        for (let i = 0; i < MAX_CHANNEL_FAILURES; i++) {
            await store.failed('200', 'down', NOW);
        }
        [row] = await store.channels('100');
        assert.equal(row?.status, 'failed');
    });

    it('stores messages, replaces them on edit, and keeps none of a redacted author', async () => {
        await store.saveMessages(
            '100',
            [{ message: message('11'), redacted: false }],
            NOW
        );
        const edited = message('11', {
            content: 'edited',
            edited_timestamp: '2026-11-26T11:00:00+00:00',
        });
        await store.saveMessages(
            '100',
            [{ message: edited, redacted: false }],
            NOW
        );
        await store.saveMessages(
            '100',
            [{ message: message('12'), redacted: true }],
            NOW
        );
        const rows = await db.query(
            `SELECT "messageId", raw->>'content' AS content, redacted FROM ${TABLES.archiveMessages} ORDER BY 1`,
            { type: 'SELECT' }
        );
        assert.deepEqual(rows, [
            { messageId: '11', content: 'edited', redacted: false },
            { messageId: '12', content: null, redacted: true },
        ]);
        assert.equal(await store.hasMessage('11'), true);
        assert.equal(await store.hasMessage('12'), false);
    });

    it('tracks files, retries due ones, and holds them for space', async () => {
        await store.saveMessages(
            '100',
            [{ message: message('11'), redacted: false }],
            NOW
        );
        await store.saveFiles([file('20', '11'), file('21', '11')], NOW);
        await store.saveFiles([file('20', '11')], NOW);
        await store.fileStored(
            'attachment',
            '20',
            { sha256: SHA_A, size: 5 },
            NOW
        );
        assert.equal(await store.fileWanted('attachment', '20'), false);
        assert.equal(await store.fileWanted('attachment', '21'), true);
        await store.fileFailed('attachment', '21', NOW);
        assert.deepEqual(await store.filesToRetry(10, NOW), []);
        const later = new Date(NOW.getTime() + FILE_RETRY_MS + 1);
        assert.deepEqual(await store.filesToRetry(10, later), [
            {
                kind: 'attachment',
                sourceId: '21',
                messageId: '11',
                channelId: '200',
            },
        ]);
        await store.fileHeld('attachment', '21', later);
        assert.deepEqual(await store.filesToRetry(10, later), []);
        const totals = await store.totals();
        assert.deepEqual(
            [totals.messages, totals.stored, totals.pending, totals.bytes],
            [1, 1, 1, 5]
        );
    });

    it('deletes a message and returns only bytes nothing else uses', async () => {
        for (const id of ['11', '12']) {
            await store.saveMessages(
                '100',
                [
                    {
                        message: message(id, {
                            attachments: [attachment(`2${id}`)],
                        }),
                        redacted: false,
                    },
                ],
                NOW
            );
        }
        await store.saveFiles(
            [file('211', '11'), file('212', '11'), file('213', '12')],
            NOW
        );
        await store.fileStored(
            'attachment',
            '211',
            { sha256: SHA_A, size: 1 },
            NOW
        );
        await store.fileStored(
            'attachment',
            '212',
            { sha256: SHA_B, size: 1 },
            NOW
        );
        await store.fileStored(
            'attachment',
            '213',
            { sha256: SHA_A, size: 1 },
            NOW
        );
        assert.deepEqual(await store.deleteMessage('11'), [SHA_B]);
        assert.equal(await store.hasMessage('11'), false);
        assert.deepEqual(await store.deleteMessage('12'), [SHA_A]);
    });

    it('redacts authors who opted out, with their files', async () => {
        await store.saveMessages(
            '100',
            [{ message: message('11'), redacted: false }],
            NOW
        );
        await store.saveFiles([file('20', '11')], NOW);
        await store.fileStored(
            'attachment',
            '20',
            { sha256: SHA_A, size: 1 },
            NOW
        );
        assert.deepEqual(await store.optedOut(['300', '301']), new Set());
        await db.query(
            `INSERT INTO ${TABLES.historyOptOuts} ("discordUserId", "createdAt") VALUES ('300', now())`
        );
        assert.deepEqual(
            await store.optedOut(['300', '301']),
            new Set(['300'])
        );
        assert.deepEqual(await store.redactOptedOut(100), [SHA_A]);
        assert.equal(await store.hasMessage('11'), false);
        assert.deepEqual(await store.redactOptedOut(100), []);
    });

    it('keeps the latest member snapshot', async () => {
        const member = {
            guildId: '100',
            userId: '300',
            username: 'ravenstryker',
            globalName: 'RavenStryker',
            nick: 'Jake',
            avatar: null,
            serverAvatar: null,
            inGuild: true,
        };
        await store.saveMember(member, NOW);
        const later = new Date(NOW.getTime() + 1000);
        await store.saveMember(
            { ...member, nick: null, inGuild: false },
            later
        );
        const seen = await store.membersSeen('100', ['300', '301']);
        assert.deepEqual([...seen.entries()], [['300', later]]);
        const rows = await db.query(
            `SELECT nick, "inGuild" FROM ${TABLES.archiveMembers}`,
            { type: 'SELECT' }
        );
        assert.deepEqual(rows, [{ nick: null, inGuild: false }]);
    });
});

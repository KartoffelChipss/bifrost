import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileFetcher } from '../../src/archive/fileFetch';
import type { FileRetry, MessageRow } from '../../src/archive/store';
import type { FileRef } from '../../src/archive/types';
import { ArchiveUpkeep } from '../../src/archive/upkeep';
import { FileGoneError } from '../../src/services/fluxerFiles';
import { createRecordingLogger } from '../addons/fakes';
import { attachment, rawMessage } from './fakes';

const NOW = new Date('2026-11-26T12:00:00Z');
const GB = 1024 ** 3;

const REF: FileRef = {
    kind: 'attachment',
    sourceId: '20',
    messageId: '11',
    filename: '20.png',
    size: 10,
    contentType: 'image/png',
    url: 'https://cdn/20',
};

function fetchStore(wanted = true) {
    const calls: string[] = [];
    const store = {
        fileWanted: async () => wanted,
        fileStored: async (_k: string, id: string) => {
            calls.push(`stored ${id}`);
        },
        fileGone: async (_k: string, id: string) => {
            calls.push(`gone ${id}`);
        },
        fileFailed: async (_k: string, id: string) => {
            calls.push(`failed ${id}`);
        },
        fileHeld: async (_k: string, id: string) => {
            calls.push(`held ${id}`);
        },
    };
    return { store, calls };
}

function fetcher(
    store: ReturnType<typeof fetchStore>['store'],
    put: () => Promise<{ sha256: string; size: number }>,
    free = 100 * GB
) {
    const logger = createRecordingLogger();
    const f = new FileFetcher({
        store,
        files: { put, remove: async () => {}, freeBytes: async () => free },
        minFreeBytes: 20 * GB,
        logger,
        now: () => NOW,
    });
    return { f, logger };
}

describe('FileFetcher', () => {
    const ok = async () => ({ sha256: 'a'.repeat(64), size: 10 });

    it('stores a wanted file and skips one already handled', async () => {
        const s = fetchStore();
        assert.equal(await fetcher(s.store, ok).f.fetch(REF), 'stored');
        assert.deepEqual(s.calls, ['stored 20']);
        const done = fetchStore(false);
        assert.equal(await fetcher(done.store, ok).f.fetch(REF), 'skipped');
    });

    it('records gone and failed downloads', async () => {
        const gone = fetchStore();
        const goneFetch = fetcher(gone.store, async () => {
            throw new FileGoneError('https://cdn/20', 404);
        });
        assert.equal(await goneFetch.f.fetch(REF), 'gone');
        const failed = fetchStore();
        const failFetch = fetcher(failed.store, async () => {
            throw new Error('reset');
        });
        assert.equal(await failFetch.f.fetch(REF), 'failed');
        assert.deepEqual(
            [...gone.calls, ...failed.calls],
            ['gone 20', 'failed 20']
        );
    });

    it('holds files while the volume is under its reserve, logging once', async () => {
        const s = fetchStore();
        const { f, logger } = fetcher(s.store, ok, 19 * GB);
        assert.equal(await f.fetch(REF), 'held');
        assert.equal(await f.fetch(REF), 'held');
        assert.deepEqual(s.calls, ['held 20', 'held 20']);
        assert.equal(
            logger.entries.filter((e) => e.level === 'warn').length,
            1
        );
    });
});

describe('ArchiveUpkeep', () => {
    function upkeep(fields: {
        retries?: FileRetry[];
        message?: unknown;
        archived?: boolean;
        dropped?: string[];
    }) {
        const calls: string[] = [];
        const saved: MessageRow[] = [];
        const u = new ArchiveUpkeep({
            store: {
                filesToRetry: async () => fields.retries ?? [],
                fileGone: async (_k: string, id: string) => {
                    calls.push(`gone ${id}`);
                },
                fileFailed: async (_k: string, id: string) => {
                    calls.push(`failed ${id}`);
                },
                redactOptedOut: async () => fields.dropped ?? [],
                deleteMessage: async () => fields.dropped ?? [],
                hasMessage: async () => fields.archived ?? true,
                optedOut: async () => new Set<string>(),
                saveMessages: async (
                    _g: string,
                    rows: readonly MessageRow[]
                ) => {
                    saved.push(...rows);
                },
            },
            source: { message: async () => fields.message ?? null },
            fetcher: {
                fetch: async (ref: FileRef) => {
                    calls.push(`fetch ${ref.url}`);
                    return 'stored' as const;
                },
            },
            files: {
                remove: async (sha: string) => {
                    calls.push(`remove ${sha}`);
                },
            },
            logger: createRecordingLogger(),
            now: () => NOW,
        });
        return { u, calls, saved };
    }

    const retry: FileRetry = {
        kind: 'attachment',
        sourceId: '20',
        messageId: '11',
        channelId: '200',
    };

    it('retries a file with the fresh link from the message', async () => {
        const fresh = rawMessage('11', { attachments: [attachment('20')] });
        const { u, calls } = upkeep({ retries: [retry], message: fresh });
        await u.retryFiles(Date.now() + 60_000);
        assert.deepEqual(calls, [`fetch ${attachment('20').url}`]);
    });

    it('marks a file gone when its message or attachment is gone', async () => {
        const { u, calls } = upkeep({ retries: [retry], message: null });
        await u.retryFiles(Date.now() + 60_000);
        const other = upkeep({ retries: [retry], message: rawMessage('11') });
        await other.u.retryFiles(Date.now() + 60_000);
        assert.deepEqual([...calls, ...other.calls], ['gone 20', 'gone 20']);
    });

    it('stores an edit only for an archived message', async () => {
        const edited = rawMessage('11', { content: 'edited' });
        const archived = upkeep({ message: edited });
        await archived.u.edited('100', '200', '11');
        assert.equal(archived.saved.length, 1);
        const unknown = upkeep({ message: edited, archived: false });
        await unknown.u.edited('100', '200', '11');
        assert.equal(unknown.saved.length, 0);
    });

    it('deletes the bytes a deleted or redacted message alone used', async () => {
        const { u, calls } = upkeep({ dropped: ['b'.repeat(64)] });
        await u.deleted('11');
        assert.equal(await u.redactOptedOut(), 1);
        assert.deepEqual(calls, [
            `remove ${'b'.repeat(64)}`,
            `remove ${'b'.repeat(64)}`,
        ]);
    });
});

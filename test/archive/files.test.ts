import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DiskFileStore, type Fetch } from '../../src/archive/files';
import { FileGoneError } from '../../src/services/fluxerFiles';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function fetcher(responses: Record<string, Response>): Fetch {
    return async (url) => {
        const res = responses[url];
        if (!res) throw new Error(`unexpected ${url}`);
        return res.clone();
    };
}

describe('DiskFileStore', () => {
    let root: string;

    before(async () => {
        root = await mkdtemp(join(tmpdir(), 'bf-archive-'));
    });
    after(() => rm(root, { recursive: true, force: true }));

    it('stores a file under its SHA-256 once, and leaves no temp file', async () => {
        const store = new DiskFileStore(
            root,
            fetcher({
                'https://a': new Response('hello'),
                'https://b': new Response('hello'),
            })
        );
        await store.init();
        const first = await store.put('https://a');
        const second = await store.put('https://b');
        assert.deepEqual(first, { sha256: sha('hello'), size: 5 });
        assert.deepEqual(second, first);
        const path = join(
            root,
            'files',
            first.sha256.slice(0, 2),
            first.sha256
        );
        assert.equal(await readFile(path, 'utf8'), 'hello');
        assert.deepEqual(await readdir(join(root, 'tmp')), []);
    });

    it('throws FileGoneError for a file Discord no longer serves', async () => {
        const store = new DiskFileStore(
            root,
            fetcher({ 'https://gone': new Response('', { status: 404 }) })
        );
        await assert.rejects(store.put('https://gone'), FileGoneError);
    });

    it('throws on any other bad status, and cleans up', async () => {
        const store = new DiskFileStore(
            root,
            fetcher({ 'https://down': new Response('', { status: 503 }) })
        );
        await assert.rejects(store.put('https://down'), /503/);
        assert.deepEqual(await readdir(join(root, 'tmp')), []);
    });

    it('removes stored bytes, and refuses a path that is not a hash', async () => {
        const store = new DiskFileStore(
            root,
            fetcher({ 'https://c': new Response('bye') })
        );
        const { sha256 } = await store.put('https://c');
        await store.remove(sha256);
        await store.remove(sha256);
        const dir = await readdir(join(root, 'files', sha256.slice(0, 2)));
        assert.ok(!dir.includes(sha256));
        await assert.rejects(store.remove('../../etc/passwd'), /not a SHA-256/);
    });

    it('reports free space on the volume', async () => {
        const store = new DiskFileStore(root, fetcher({}));
        assert.ok((await store.freeBytes()) > 0);
    });
});

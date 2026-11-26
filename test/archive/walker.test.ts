import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FileOutcome } from '../../src/archive/fileFetch';
import type { MessageRow } from '../../src/archive/store';
import type { FileRef, RawUser } from '../../src/archive/types';
import { ArchiveWalker, toPage } from '../../src/archive/walker';
import { createRecordingLogger } from '../addons/fakes';
import { attachment, progress, rawMessage } from './fakes';

const NOW = new Date('2026-11-26T12:00:00Z');
const FAR = () => Date.now() + 60_000;

/** An archive store that records what the walker did. */
function fakeStore(optedOut: string[] = []) {
    const calls: string[] = [];
    const saved: MessageRow[] = [];
    const files: FileRef[] = [];
    const store = {
        saveMessages: async (_g: string, rows: readonly MessageRow[]) => {
            saved.push(...rows);
        },
        optedOut: async (ids: readonly string[]) =>
            new Set(ids.filter((id) => optedOut.includes(id))),
        saveFiles: async (refs: readonly FileRef[]) => {
            files.push(...refs);
        },
        advance: async (_c: string, afterId: string, added: number) => {
            calls.push(`advance ${afterId} +${added}`);
        },
        caughtUp: async () => {
            calls.push('caughtUp');
        },
        setStatus: async (_c: string, status: string) => {
            calls.push(`status ${status}`);
        },
        failed: async (_c: string, error: string) => {
            calls.push(`failed ${error}`);
        },
    };
    return { store, calls, saved, files };
}

/** Pages served after each `after` ID. */
function source(pages: Record<string, unknown[] | Error>) {
    const asked: string[] = [];
    return {
        asked,
        source: {
            page: async (_c: string, afterId: string) => {
                asked.push(afterId);
                const page = pages[afterId] ?? [];
                if (page instanceof Error) throw page;
                return page;
            },
        },
    };
}

function walker(
    store: ReturnType<typeof fakeStore>['store'],
    src: ReturnType<typeof source>['source'],
    outcome: FileOutcome = 'stored'
) {
    const authors: RawUser[][] = [];
    const fetched: string[] = [];
    const w = new ArchiveWalker({
        store,
        source: src,
        members: {
            refresh: async (_g: string, list: readonly RawUser[]) => {
                authors.push([...list]);
            },
        },
        fetcher: {
            fetch: async (ref: FileRef) => {
                fetched.push(ref.sourceId);
                return outcome;
            },
        },
        logger: createRecordingLogger(),
        now: () => NOW,
    });
    return { w, authors, fetched };
}

describe('ArchiveWalker', () => {
    it('walks pages oldest first until an empty page, then is current', async () => {
        const fake = fakeStore();
        const { source: src, asked } = source({
            '0': [rawMessage('12'), rawMessage('11')],
            '12': [rawMessage('13', { attachments: [attachment('20')] })],
        });
        const { w, fetched } = walker(fake.store, src);
        const result = await w.walk(progress(), FAR());
        assert.deepEqual(asked, ['0', '12', '13']);
        assert.deepEqual(
            fake.saved.map((r) => r.message.id),
            ['11', '12', '13']
        );
        assert.deepEqual(fake.calls, [
            'advance 12 +2',
            'advance 13 +1',
            'caughtUp',
        ]);
        assert.deepEqual(fetched, ['20']);
        assert.deepEqual(result, { messages: 3, files: 1, more: false });
    });

    it('stores an opted-out author redacted, without members or files', async () => {
        const fake = fakeStore(['300']);
        const { source: src } = source({
            '0': [rawMessage('11', { attachments: [attachment('20')] })],
        });
        const { w, authors, fetched } = walker(fake.store, src);
        await w.walk(progress(), FAR());
        assert.equal(fake.saved[0]?.redacted, true);
        assert.deepEqual(authors, [[]]);
        assert.deepEqual(fetched, []);
    });

    it('marks a channel forbidden on 403 and counts other failures', async () => {
        const forbidden = Object.assign(new Error('Missing Access'), {
            status: 403,
        });
        const fake = fakeStore();
        await walker(fake.store, source({ '0': forbidden }).source).w.walk(
            progress(),
            FAR()
        );
        assert.deepEqual(fake.calls, ['status forbidden']);
        const other = fakeStore();
        await walker(
            other.store,
            source({ '0': new Error('Service Unavailable') }).source
        ).w.walk(progress(), FAR());
        assert.deepEqual(other.calls, ['failed Service Unavailable']);
    });

    it('stops at the deadline with pages left', async () => {
        const fake = fakeStore();
        const { source: src, asked } = source({ '0': [rawMessage('11')] });
        const result = await walker(fake.store, src).w.walk(
            progress(),
            Date.now() - 1
        );
        assert.deepEqual(asked, []);
        assert.equal(result.more, true);
    });

    it('moves past a page whose messages do not parse', () => {
        const page = toPage([{ id: '15' }, rawMessage('12'), 'junk']);
        assert.equal(page.lastId, '15');
        assert.deepEqual(
            page.messages.map((m) => m.id),
            ['12']
        );
        assert.equal(toPage([]).lastId, null);
    });
});

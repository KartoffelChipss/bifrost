import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HistoryEditor, type EditorThreads } from '../../src/history/editor';
import { CopyFormatter } from '../../src/history/format';
import type { HistoryMode } from '../../src/history/importer';
import { HistoryMirror } from '../../src/history/mirror';
import { createRecordingLogger } from '../addons/fakes';
import { FakeLinker } from '../guild-sync/fake-store';
import { FakeHistoryPorts, FakeHistoryStore } from './fakes';

async function setup() {
    const store = new FakeHistoryStore();
    const ports = new FakeHistoryPorts();
    const links = new FakeLinker();
    const logger = createRecordingLogger();
    const state = { mode: 'apply' as HistoryMode, loads: 0 };
    await store.ensureJob('link-1', 'channel', '10', null);
    const job = store.job('10');
    await store.updateJob(job.id, {
        fluxerId: 'f10',
        importWebhook: { id: 'import-f10', token: 'secret' },
    });
    ports.add('10', '11');
    await store.startMessage({
        discordMessageId: '11',
        jobId: job.id,
        discordAuthorId: 'author',
        fluxerMessageId: 'copy-11',
        fluxerTargetId: 'f10',
        inThread: false,
        webhookId: 'import-f10',
    });
    const mirror = new HistoryMirror({
        store,
        editor: new HistoryEditor(store, links, ports),
        formatter: new CopyFormatter({ store, ports, commandPrefix: '!b ' }),
        ports,
        mode: async () => state.mode,
        logger,
    });
    /** Loads the edited message, counting the loads. */
    const load = (text: string | null) => async () => {
        state.loads += 1;
        return text === null ? null : { id: '11', text };
    };
    return { store, ports, logger, state, mirror, load };
}

describe('HistoryMirror', () => {
    it('edits the copy with the new text and the original date', async () => {
        const s = await setup();
        await s.mirror.edited('11', s.load('!b fixed typo'));
        assert.deepEqual(s.ports.edits, [
            'edit import-f10 copy-11 ​!b fixed typo\n*Originally posted 2024-03-01 18:22 UTC*',
        ]);
    });

    it('deletes the copy and forgets it', async () => {
        const s = await setup();
        await s.mirror.deleted('11');
        assert.deepEqual(s.ports.edits, ['delete import-f10 copy-11']);
        assert.equal(await s.store.importedByDiscordId('11'), null);
    });

    it('changes nothing outside apply', async () => {
        const s = await setup();
        s.state.mode = 'dry-run';
        await s.mirror.edited('11', s.load('new'));
        await s.mirror.deleted('11');
        assert.deepEqual(s.ports.edits, []);
        assert.equal(s.state.loads, 0);
    });

    it('ignores messages without a copy and updates that are not edits', async () => {
        const s = await setup();
        await s.mirror.edited('99', s.load('new'));
        assert.equal(s.state.loads, 0);
        await s.mirror.edited('11', s.load(null));
        assert.equal(s.state.loads, 1);
        assert.deepEqual(s.ports.edits, []);
    });

    it('replaces an opted-out author edit with the placeholder', async () => {
        const s = await setup();
        s.store.optOuts.add('author');
        await s.mirror.edited('11', s.load('my address is redacted'));
        assert.deepEqual(s.ports.edits, [
            'edit import-f10 copy-11 *A message from a member who opted out of history import.*\n*Originally posted 2024-03-01 18:22 UTC*',
        ]);
    });

    it('logs a failed edit and does not throw', async () => {
        const s = await setup();
        s.ports.editCopy = async () => {
            throw new Error('404');
        };
        await s.mirror.edited('11', s.load('new'));
        assert.match(s.logger.entries[0]?.message ?? '', /edit: 404/);
    });
});

describe('HistoryEditor in a closed Fluxer thread', () => {
    const closed = (code: string) =>
        Object.assign(new Error(code), { statusCode: 400, code });

    /** A copy in an archive thread of history, or in an imported thread. */
    async function threadCopy(where: 'archive' | 'thread') {
        const store = new FakeHistoryStore();
        const ports = new FakeHistoryPorts();
        const links = new FakeLinker();
        const archive = where === 'archive';
        await store.ensureJob(
            'link-1',
            archive ? 'channel' : 'thread',
            archive ? '10' : '200',
            archive ? null : '20'
        );
        const job = store.jobs[0];
        await store.updateJob(job.id, {
            status: 'done',
            fluxerId: archive ? 'f10' : 'f200',
            importWebhook: archive
                ? { id: 'import-f10', token: 'secret' }
                : null,
            archiveThreadId: archive ? 'thread-of-f10' : null,
        });
        await links.link('link-1', '20', 'f20');
        const copy = {
            discordMessageId: '11',
            jobId: job.id,
            discordAuthorId: 'author',
            fluxerMessageId: 'copy-11',
            fluxerTargetId: archive ? 'thread-of-f10' : 'f200',
            inThread: true,
            webhookId: archive ? 'import-f10' : 'fw-f20',
        };
        await store.startMessage(copy);
        const states: string[] = [];
        const discord = { archived: true, locked: false };
        const threads: EditorThreads = {
            discordState: async () => discord,
            setState: async (linkId, id, state) => {
                states.push(`${linkId} ${id} ${JSON.stringify(state)}`);
            },
        };
        /** Edits fail with `codes`, in turn, then go through. */
        const refuse = (...codes: string[]) => {
            const original = ports.editCopy.bind(ports);
            ports.editCopy = async (target, id, content) => {
                const code = codes.shift();
                if (code) throw closed(code);
                return original(target, id, content);
            };
        };
        const editor = new HistoryEditor(store, links, ports, threads);
        return { copy, ports, states, discord, refuse, editor };
    }

    const OPENED = '{"archived":false,"locked":false}';

    it('opens a closed archive thread for the edit and closes it again', async () => {
        const s = await threadCopy('archive');
        s.refuse('THREAD_ARCHIVED');
        await s.editor.replace(s.copy, 'fixed');
        assert.deepEqual(s.ports.edits, ['edit import-f10 copy-11 fixed']);
        assert.deepEqual(s.states, [
            `link-1 thread-of-f10 ${OPENED}`,
            'link-1 thread-of-f10 {"archived":true,"locked":true}',
        ]);
    });

    it('puts an imported thread back as it was: locked only, or archived as on Discord', async () => {
        const s = await threadCopy('thread');
        s.refuse('THREAD_LOCKED');
        await s.editor.replace(s.copy, 'fixed');
        assert.deepEqual(s.states, [
            `link-1 f200 ${OPENED}`,
            'link-1 f200 {"archived":false,"locked":true}',
        ]);

        const t = await threadCopy('thread');
        t.refuse('THREAD_ARCHIVED');
        await t.editor.replace(t.copy, 'fixed');
        assert.deepEqual(t.states, [
            `link-1 f200 ${OPENED}`,
            'link-1 f200 {"archived":true,"locked":false}',
        ]);
        assert.deepEqual(t.ports.edits, ['edit fw-f20 copy-11 fixed']);
    });

    it('closes the thread again when the second try fails too', async () => {
        const s = await threadCopy('archive');
        s.refuse('THREAD_ARCHIVED', 'THREAD_ARCHIVED');
        await assert.rejects(s.editor.replace(s.copy, 'fixed'));
        assert.deepEqual(s.states, [
            `link-1 thread-of-f10 ${OPENED}`,
            'link-1 thread-of-f10 {"archived":true,"locked":true}',
        ]);
    });
});

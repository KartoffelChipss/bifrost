import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HistoryEditor } from '../../src/history/editor';
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

    it('ignores messages without a copy, updates that are not edits and opted-out authors', async () => {
        const s = await setup();
        await s.mirror.edited('99', s.load('new'));
        assert.equal(s.state.loads, 0);
        await s.mirror.edited('11', s.load(null));
        s.store.optOuts.add('author');
        await s.mirror.edited('11', s.load('new'));
        assert.equal(s.state.loads, 1);
        assert.deepEqual(s.ports.edits, []);
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

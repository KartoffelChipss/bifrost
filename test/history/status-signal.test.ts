import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StatusSignal } from '../../src/guild-sync/statusSignal';
import { importLinks, noticeCategory } from '../../src/history';
import type { HistoryImporter } from '../../src/history/importer';
import { createRecordingLogger } from '../addons/fakes';

describe('StatusSignal', () => {
    it('reaches the listener until it stops listening', () => {
        const signal = new StatusSignal();
        const heard: string[] = [];
        signal.notify('before');
        const stop = signal.listen((id) => heard.push(id));
        signal.notify('a');
        stop();
        signal.notify('b');
        assert.deepEqual(heard, ['a']);
    });
});

describe('history and the status message', () => {
    it('asks for a status update after each link it ran', async () => {
        const signal = new StatusSignal();
        const heard: string[] = [];
        signal.listen((id) => heard.push(id));
        const importer = {
            run: async (link: { id: string }) => {
                if (link.id === 'a') throw new Error('db down');
                return false;
            },
            waiting: async () => false,
        } as unknown as HistoryImporter;
        await importLinks(
            {
                listGuildLinks: async () => [
                    { id: 'a', discordGuildId: '1', fluxerGuildId: '2' },
                    { id: 'b', discordGuildId: '3', fluxerGuildId: '4' },
                ],
                statusSignal: signal,
            },
            importer,
            createRecordingLogger()
        );
        assert.deepEqual(heard, ['a', 'b']);
    });

    it('dedupes each kind of history notice on its own', () => {
        assert.equal(noticeCategory('done:10:2:0'), 'done');
        assert.equal(noticeCategory('failed:job-1'), 'failed');
        assert.equal(noticeCategory('survey'), 'survey');
        assert.notEqual(
            noticeCategory('failed:job-1'),
            noticeCategory('done:1:0:0')
        );
    });
});

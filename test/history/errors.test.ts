import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    MessageError,
    isTransient,
    isUploadError,
} from '../../src/history/errors';
import { WaitThrottle, WAIT_POLL_MS, importLinks } from '../../src/history';
import type { HistoryImporter } from '../../src/history/importer';
import { createRecordingLogger } from '../addons/fakes';

const withFields = (message: string, extra: Record<string, unknown>) =>
    Object.assign(new Error(message), extra);

describe('error classes', () => {
    it('treats rate limits, server errors, timeouts and a cold gateway as temporary', () => {
        for (const error of [
            withFields('Too Many Requests', { statusCode: 429 }),
            withFields('Bad Gateway', { status: 502 }),
            withFields('read', { code: 'ECONNRESET' }),
            withFields('aborted', { name: 'AbortError' }),
            new Error('Fluxer gateway is not ready'),
            withFields('fetch failed', {
                cause: withFields('x', { code: 'UND_ERR_SOCKET' }),
            }),
            new MessageError('1', withFields('x', { statusCode: 503 })),
        ]) {
            assert.equal(isTransient(error), true, String(error));
        }
    });

    it('treats validation and permission errors as lasting', () => {
        assert.equal(
            isTransient(withFields('Invalid', { status: 400 })),
            false
        );
        assert.equal(
            isTransient(withFields('Missing', { statusCode: 403 })),
            false
        );
        assert.equal(isTransient(new Error('Unknown Channel')), false);
    });

    it('recognises upload refusals only', () => {
        assert.equal(
            isUploadError(withFields('big', { statusCode: 413 })),
            true
        );
        assert.equal(
            isUploadError(withFields('x', { code: 'FILE_SIZE_TOO_LARGE' })),
            true
        );
        assert.equal(
            isUploadError(
                withFields('x', {
                    statusCode: 400,
                    errors: [{ path: 'attachments.0', message: 'bad' }],
                })
            ),
            true
        );
        assert.equal(
            isUploadError(withFields('x', { statusCode: 503 })),
            false
        );
        assert.equal(
            isUploadError(
                withFields('x', {
                    statusCode: 400,
                    errors: [{ path: 'content', message: 'too long' }],
                })
            ),
            false
        );
    });
});

describe('history loop', () => {
    it('polls a waiting job every WAIT_POLL_MS instead of every second', () => {
        let now = 0;
        const throttle = new WaitThrottle(() => now);
        assert.equal(throttle.after({ more: false, waiting: false }), false);
        assert.equal(throttle.after({ more: false, waiting: true }), true);
        now += WAIT_POLL_MS - 1;
        assert.equal(throttle.resting(), true);
        now += 1;
        assert.equal(throttle.resting(), false);
    });

    it('logs a failed link pass and carries on with the others', async () => {
        const logger = createRecordingLogger();
        const ran: string[] = [];
        const importer = {
            run: async (link: { id: string }) => {
                if (link.id === 'a') throw new Error('db down');
                ran.push(link.id);
                return false;
            },
            waiting: async () => false,
        } as unknown as HistoryImporter;
        const result = await importLinks(
            {
                listGuildLinks: async () => [
                    { id: 'a', discordGuildId: '1', fluxerGuildId: '2' },
                    { id: 'b', discordGuildId: '3', fluxerGuildId: '4' },
                ],
            },
            importer,
            logger
        );
        assert.deepEqual(ran, ['b']);
        assert.deepEqual(result, { more: false, waiting: true });
        assert.equal(logger.entries.length, 1);
    });
});

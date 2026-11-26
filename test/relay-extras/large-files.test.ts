import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Webhook as FluxerWebhook } from '@fluxerjs/core';
import {
    FILE_DOWNLOAD_TIMEOUT_MS,
    FileGoneError,
    FLUXER_MAX_FILE_BYTES,
    prepareFiles,
    withLines,
} from '../../src/services/fluxerFiles';
import { fetchedUrls, loadWebhookService } from './fidelity-fakes';

type Options = Record<string, unknown>;

const small = (url: string) => async () => new TextEncoder().encode(url).buffer;

describe('files for a Fluxer copy', () => {
    it('leaves out a file declared too large and lists it instead', async () => {
        const fetched: string[] = [];
        const result = await prepareFiles(
            [
                {
                    url: 'https://cdn/big.mp4',
                    name: 'big.mp4',
                    size: FLUXER_MAX_FILE_BYTES + 1,
                },
                { url: 'https://cdn/ok.png', name: 'ok.png', size: 10 },
            ],
            async (url, timeout) => {
                fetched.push(url);
                assert.equal(timeout, FILE_DOWNLOAD_TIMEOUT_MS);
                return small(url)();
            }
        );
        assert.deepEqual(fetched, ['https://cdn/ok.png']);
        assert.deepEqual(result.kept, [1]);
        assert.deepEqual(
            result.files.map((f) => f.name),
            ['ok.png']
        );
        assert.equal(result.lines.length, 1);
        assert.match(
            result.lines[0],
            /big\.mp4 \(50\.0 MB\) is too large to copy to Fluxer: https:\/\/cdn\/big\.mp4/
        );
    });

    it('leaves out a file that turns out too large once downloaded', async () => {
        const result = await prepareFiles(
            [{ url: 'https://cdn/x.bin', name: 'x.bin' }],
            async () => new ArrayBuffer(FLUXER_MAX_FILE_BYTES + 1)
        );
        assert.deepEqual(result.files, []);
        assert.equal(result.lines.length, 1);
    });

    it('adds the lines under the text, within the limit', () => {
        assert.equal(withLines('hi', []), 'hi');
        assert.equal(withLines('hi', ['a', 'b']), 'hi\na\nb');
        assert.equal(withLines('', ['a']), 'a');
        assert.equal(withLines('x'.repeat(4000), ['a']).length, 4000);
    });

    it('sends the message with the files Fluxer can take', async () => {
        const sent: Options[] = [];
        const webhook = {
            send: async (options: Options) => {
                sent.push(options);
                return { id: 'm1' };
            },
        } as unknown as FluxerWebhook;
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaFluxerWebhook(webhook, {
            content: 'clip',
            username: 'member',
            avatarURL: 'https://cdn/a.png',
            attachments: [
                {
                    url: 'https://cdn/big.mp4',
                    name: 'big.mp4',
                    size: FLUXER_MAX_FILE_BYTES * 2,
                },
                {
                    url: 'https://cdn/ok.png',
                    name: 'ok.png',
                    size: 10,
                    spoiler: true,
                },
            ],
        });
        assert.equal(sent.length, 1);
        assert.deepEqual(fetchedUrls(sent[0].files), ['https://cdn/ok.png']);
        const attachments = sent[0].attachments as {
            id: number;
            name: string;
        }[];
        assert.deepEqual(
            attachments.map((a) => [a.id, a.name]),
            [[0, 'ok.png']]
        );
        assert.match(
            String(sent[0].content),
            /^clip\n📎 big\.mp4 \(100\.0 MB\) is too large/
        );
    });
});

describe('files Discord no longer serves', () => {
    it('leaves out a gone file and lists it, keeping the rest', async () => {
        const result = await prepareFiles(
            [
                { url: 'https://media/sticker.webp', name: 'wave.webp' },
                { url: 'https://cdn/ok.png', name: 'ok.png' },
            ],
            async (url) => {
                if (url.includes('sticker')) throw new FileGoneError(url, 404);
                return new TextEncoder().encode(url).buffer;
            }
        );
        assert.deepEqual(result.kept, [1]);
        assert.deepEqual(result.lines, [
            '📎 wave.webp is no longer available on Discord',
        ]);
    });

    it('still fails on a download error that is not a gone file', async () => {
        await assert.rejects(
            prepareFiles([{ url: 'https://cdn/x', name: 'x' }], async () => {
                throw new Error('Failed to fetch file from https://cdn/x: 500');
            }),
            /500/
        );
    });
});

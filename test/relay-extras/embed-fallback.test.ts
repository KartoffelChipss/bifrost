import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Webhook as FluxerWebhook } from '@fluxerjs/core';
import {
    embedFallback,
    withoutEmbedPart,
} from '../../src/relay-extras/fidelity/embedFallback';
import WebhookEmbed from '../../src/services/WebhookEmbed';
import type { WebhookMessageData } from '../../src/services/WebhookService';
import { loadWebhookService } from './fidelity-fakes';

type Options = Record<string, unknown>;

const unavailable = () =>
    Object.assign(new Error('Service unavailable.'), { statusCode: 503 });

function copy(): WebhookMessageData {
    return {
        content: 'patch notes',
        username: 'PatchBot',
        avatarURL: 'https://cdn/a.png',
        embeds: [
            new WebhookEmbed({
                title: 'Season 2',
                url: 'https://patchbot.io/x',
                image: { url: 'https://www.callofduty.com/i.jpg' },
                thumbnail: { url: 'https://cdn.patchbot.io/t.png' },
                footer: { text: 'PatchBot', iconURL: 'https://cdn/f.png' },
            }),
        ],
    };
}

function scripted(results: (Error | null)[]) {
    const sent: Options[] = [];
    const webhook = {
        send: async (options: Options) => {
            sent.push(options);
            const result = results[sent.length - 1];
            if (result) throw result;
            return { id: `m${sent.length}` };
        },
    } as unknown as FluxerWebhook;
    return { webhook, sent };
}

const embedsOf = (options: Options) =>
    (options.embeds as {
        image?: unknown;
        thumbnail?: unknown;
        title?: string;
    }[]) ?? [];

describe('embed fallback after a 503', () => {
    it('retries once, then drops embed images, then embeds, each once', () => {
        const data = copy();
        assert.equal(embedFallback(unavailable(), data, new Set()), 'retry');
        assert.equal(
            embedFallback(unavailable(), data, new Set(['retry'])),
            'embedImages'
        );
        assert.equal(
            embedFallback(
                unavailable(),
                data,
                new Set(['retry', 'embedImages'])
            ),
            'embeds'
        );
        assert.equal(
            embedFallback(
                unavailable(),
                data,
                new Set(['retry', 'embedImages', 'embeds'])
            ),
            null
        );
    });

    it('does nothing for other errors or a copy without embeds', () => {
        const error = Object.assign(new Error('bad'), { statusCode: 500 });
        assert.equal(embedFallback(error, copy(), new Set()), null);
        assert.equal(
            embedFallback(unavailable(), { ...copy(), embeds: [] }, new Set()),
            null
        );
    });

    it('keeps the text of an embed without its images', () => {
        const plain = withoutEmbedPart(
            copy(),
            'embedImages'
        ).embeds?.[0].toPlainObject();
        assert.equal(plain?.title, 'Season 2');
        assert.equal(plain?.url, 'https://patchbot.io/x');
        assert.equal(plain?.image, null);
        assert.equal(plain?.thumbnail, null);
        assert.equal(plain?.footer?.text, 'PatchBot');
        assert.equal(plain?.footer?.iconURL, undefined);
    });

    it('sends the copy whole when a retry works', async () => {
        const { webhook, sent } = scripted([unavailable(), null]);
        const WebhookService = await loadWebhookService();
        const result = await new WebhookService().sendCopyViaFluxerWebhook(
            webhook,
            copy()
        );
        assert.equal(result.ok, true);
        assert.equal(sent.length, 2);
        assert.ok(JSON.stringify(sent[1].embeds).includes('callofduty.com'));
    });

    it('sends the copy without embed images when Fluxer refuses it twice', async () => {
        const { webhook, sent } = scripted([
            unavailable(),
            unavailable(),
            null,
        ]);
        const WebhookService = await loadWebhookService();
        const result = await new WebhookService().sendCopyViaFluxerWebhook(
            webhook,
            copy()
        );
        assert.equal(result.ok, true);
        assert.equal(sent.length, 3);
        assert.equal(embedsOf(sent[2]).length, 1);
        const second = JSON.stringify(sent[2].embeds);
        assert.ok(!second.includes('callofduty.com'));
        assert.ok(second.includes('Season 2'));
    });

    it('sends it without embeds when the images were not the problem', async () => {
        const { webhook, sent } = scripted([
            unavailable(),
            unavailable(),
            unavailable(),
            null,
        ]);
        const WebhookService = await loadWebhookService();
        const result = await new WebhookService().sendCopyViaFluxerWebhook(
            webhook,
            copy()
        );
        assert.equal(result.ok, true);
        assert.equal(sent.length, 4);
        assert.deepEqual(sent[3].embeds, []);
        assert.equal(sent[3].content, 'patch notes');
    });

    it('gives up after every step and keeps the copy whole for the queue', async () => {
        const { webhook, sent } = scripted([
            unavailable(),
            unavailable(),
            unavailable(),
            unavailable(),
        ]);
        const WebhookService = await loadWebhookService();
        const result = await new WebhookService().sendCopyViaFluxerWebhook(
            webhook,
            copy()
        );
        assert.equal(result.ok, false);
        assert.equal(sent.length, 4);
        assert.ok(
            JSON.stringify(result.payload.embeds).includes('callofduty.com')
        );
    });
});

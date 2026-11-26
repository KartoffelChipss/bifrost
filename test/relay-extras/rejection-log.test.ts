import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadWebhookService } from './fidelity-fakes';

describe('logging a refused Fluxer copy', () => {
    it('names the refused fields and the shape, never the text', async () => {
        await loadWebhookService();
        const { describeRejection } =
            await import('../../src/services/WebhookService');
        const error = Object.assign(new Error('Invalid form body.'), {
            errors: [{ path: 'embeds.0.url', code: 'URL_TYPE_INVALID' }],
        });
        const text = describeRejection(error, {
            content: 'secret words',
            username: 'member',
            avatarURL: '',
            embeds: [],
        });
        assert.equal(
            text,
            ' (embeds.0.url=URL_TYPE_INVALID; content 12 chars, username 6 chars, 0 files, 0 embeds)'
        );
        assert.ok(!text.includes('secret'));
    });
});

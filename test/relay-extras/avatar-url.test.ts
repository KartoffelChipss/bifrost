import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Webhook as FluxerWebhook } from '@fluxerjs/core';
import { authorAvatar } from '../../src/services/messageTransformer/DiscordMessageTransformer';
import { loadWebhookService } from './fidelity-fakes';

type Options = Record<string, unknown>;

function recording() {
    const sent: Options[] = [];
    const webhook = {
        send: async (options: Options) => {
            sent.push(options);
            return { id: 'm1' };
        },
    } as unknown as FluxerWebhook;
    return { webhook, sent };
}

describe('avatar URL of a Fluxer copy', () => {
    it("uses Discord's default avatar for a member without one", () => {
        const author = {
            avatarURL: () => null,
            displayAvatarURL: () =>
                'https://cdn.discordapp.com/embed/avatars/3.png',
        };
        assert.equal(
            authorAvatar(author),
            'https://cdn.discordapp.com/embed/avatars/3.png'
        );
    });

    it('keeps a custom avatar', () => {
        const author = {
            avatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png',
            displayAvatarURL: () => 'unused',
        };
        assert.equal(
            authorAvatar(author),
            'https://cdn.discordapp.com/avatars/1/a.png'
        );
    });

    it('sends no avatar_url rather than an empty one', async () => {
        const { webhook, sent } = recording();
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaFluxerWebhook(webhook, {
            content: 'hi',
            username: 'member',
            avatarURL: '',
        });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].avatarUrl, undefined);
    });
});

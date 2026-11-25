import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Webhook as FluxerWebhook } from '@fluxerjs/core';
import { installFidelity } from '../../src/relay-extras/fidelity';
import { FidelityService } from '../../src/relay-extras/fidelity/service';
import { swapStickers } from '../../src/relay-extras/fidelity/stickers';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import { buildDiscordStickerUrl } from '../../src/utils/buildStickerUrl';
import {
    discordMessage,
    FakePorts,
    fluxerMessage,
    LINK,
    loadWebhookService,
} from './fidelity-fakes';

afterEach(() => installFidelity(null));

const url = (id: string) => buildDiscordStickerUrl(id, 160);

describe('swapStickers', () => {
    const synced = new Map([
        ['141', '241'],
        ['142', '242'],
    ]);

    it('swaps synced stickers the target server has', () => {
        const swap = swapStickers(
            [
                { id: '141', url: url('141') },
                { id: '142', url: url('142') },
                { id: '143', url: url('143') },
            ],
            synced,
            new Set(['241'])
        );
        assert.deepEqual(swap.ids, ['241']);
        assert.deepEqual([...swap.replacedUrls], [url('141')]);
    });

    it('sends at most three', () => {
        const many = ['1', '2', '3', '4'].map((id) => ({ id, url: url(id) }));
        const all = new Map(many.map((s) => [s.id, `t${s.id}`]));
        const swap = swapStickers(many, all, new Set(['t1', 't2', 't3', 't4']));
        assert.deepEqual(swap.ids, ['t1', 't2', 't3']);
    });
});

function withSticker(id: string) {
    return discordMessage({
        stickers: new Map([[id, { id, name: 'cat', format: 1 }]]),
    });
}

describe('fidelity stickers, Discord to Fluxer', () => {
    const transformer = new DiscordMessageTransformer();

    it('keeps the image when fidelity is not installed', async () => {
        const out = await transformer.transformMessage(withSticker('141'));
        assert.deepEqual(
            out.attachments?.map((a) => a.url),
            [url('141')]
        );
    });

    it('sends a synced sticker natively instead of its image', async () => {
        installFidelity(new FidelityService(new FakePorts()));
        const out = await transformer.transformMessage(withSticker('141'));
        assert.deepEqual(out.fidelity?.stickerIds, ['241']);
        assert.deepEqual(out.attachments, []);
    });

    it('keeps the image of an unsynced or deleted sticker', async () => {
        const ports = new FakePorts();
        ports.stickers.set(LINK.fluxerGuildId, new Set());
        installFidelity(new FidelityService(ports));
        const deleted = await transformer.transformMessage(withSticker('141'));
        assert.equal(deleted.fidelity?.stickerIds, undefined);
        assert.equal(deleted.attachments?.length, 1);
        const unsynced = await transformer.transformMessage(withSticker('149'));
        assert.equal(unsynced.attachments?.length, 1);
    });

    it('does not look up stickers for a message without any', async () => {
        const ports = new FakePorts();
        installFidelity(new FidelityService(ports));
        await transformer.transformMessage(discordMessage());
        assert.equal(
            ports.calls.some((c) => c.startsWith('stickers')),
            false
        );
    });
});

describe('fidelity stickers, Fluxer to Discord', () => {
    it('keeps the image: Discord webhooks cannot send stickers', async () => {
        installFidelity(new FidelityService(new FakePorts()));
        const out = await new FluxerMessageTransformer().transformMessage(
            fluxerMessage({
                stickers: [{ id: '241', name: 'cat', animated: false }],
            })
        );
        assert.equal(out.fidelity?.stickerIds, undefined);
        assert.equal(out.attachments?.length, 1);
    });
});

describe('WebhookService stickers', () => {
    it('passes stickerIds to the Fluxer webhook send', async () => {
        const sent: Record<string, unknown>[] = [];
        const webhook = {
            send: async (options: Record<string, unknown>) => {
                sent.push(options);
                return { id: 'm1' };
            },
        } as unknown as FluxerWebhook;
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaFluxerWebhook(webhook, {
            content: '',
            username: 'a',
            avatarURL: '',
            fidelity: { stickerIds: ['241'] },
        });
        assert.deepEqual(sent[0].stickerIds, ['241']);
    });
});

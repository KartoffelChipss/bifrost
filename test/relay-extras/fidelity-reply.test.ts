import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Webhook as FluxerWebhook } from '@fluxerjs/core';
import { MessageType } from 'discord.js';
import {
    UpstreamBridge,
    type UpstreamServices,
} from '../../src/guild-sync/upstreamBridge';
import { installFidelity } from '../../src/relay-extras/fidelity';
import { replyTarget } from '../../src/relay-extras/fidelity/reply';
import { FidelityService } from '../../src/relay-extras/fidelity/service';
import type { SourceFacts } from '../../src/relay-extras/fidelity/types';
import type { MessagePair } from '../../src/relay-extras/types';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import {
    discordMessage,
    FakePorts,
    LINK,
    loadWebhookService,
} from './fidelity-fakes';

afterEach(() => installFidelity(null));

/** The replied-to Discord message 301 and its Fluxer copy 401 in 221. */
const PAIR: MessagePair = {
    guildLinkId: LINK.id,
    discord: { channelId: '121', messageId: '301' },
    fluxer: { channelId: '221', messageId: '401' },
};

const FACTS: SourceFacts = {
    side: 'discord',
    guildId: LINK.discordGuildId,
    channelId: '121',
    content: '',
    pinged: { users: [], roles: [], everyone: false },
    author: { displayName: null, avatarUrl: null },
    reply: { messageId: '301', pinged: false },
    stickers: [],
};

function ports() {
    const fake = new FakePorts();
    fake.pairs = [PAIR];
    return fake;
}

describe('replyTarget', () => {
    it('finds the counterpart in the target channel', async () => {
        const fake = ports();
        assert.deepEqual(await replyTarget(FACTS, LINK.id, '221', fake), {
            channelId: '221',
            messageId: '401',
        });
        assert.ok(fake.calls.includes('exists fluxer:221/401'));
    });

    it('gives up when there is no reply or the target is Discord', async () => {
        const fake = ports();
        const plain = { ...FACTS, reply: null };
        assert.equal(await replyTarget(plain, LINK.id, '221', fake), null);
        const fromFluxer = { ...FACTS, side: 'fluxer' as const };
        assert.equal(await replyTarget(fromFluxer, LINK.id, '121', fake), null);
        assert.deepEqual(fake.calls, []);
    });

    it('gives up without a pair, in another link or another channel', async () => {
        const fake = ports();
        assert.equal(await replyTarget(FACTS, 'other', '221', fake), null);
        assert.equal(await replyTarget(FACTS, LINK.id, '999', fake), null);
        assert.equal(await replyTarget(FACTS, LINK.id, undefined, fake), null);
        fake.pairs = [];
        assert.equal(await replyTarget(FACTS, LINK.id, '221', fake), null);
    });

    it('gives up when the counterpart was deleted', async () => {
        const fake = ports();
        fake.gone.add('401');
        assert.equal(await replyTarget(FACTS, LINK.id, '221', fake), null);
    });
});

function reply(pinged: boolean) {
    const author = { id: '102', username: 'bob', avatarURL: () => null };
    return discordMessage({
        type: MessageType.Reply,
        flags: { has: () => false },
        reference: { messageId: '301', channelId: '121' },
        mentions: {
            users: new Map(pinged ? [['102', author]] : []),
            roles: new Map(),
            everyone: false,
            repliedUser: author,
        },
        fetchReference: async () =>
            discordMessage({ id: '301', content: 'original', author }),
    });
}

describe('fidelity native replies, Discord to Fluxer', () => {
    const transformer = new DiscordMessageTransformer();

    it('replies natively and leaves out the quote', async () => {
        installFidelity(new FidelityService(ports()));
        const out = await transformer.transformMessage(reply(true));
        assert.deepEqual(out.fidelity?.replyTo, {
            channelId: '221',
            messageId: '401',
        });
        assert.equal(out.fidelity?.pings?.repliedUser, true);
        assert.deepEqual(out.embeds, []);
    });

    it('does not ping the replied author when the reply did not', async () => {
        installFidelity(new FidelityService(ports()));
        const out = await transformer.transformMessage(reply(false));
        assert.equal(out.fidelity?.pings?.repliedUser, false);
    });

    it('quotes as before when the counterpart is unknown', async () => {
        const fake = ports();
        fake.pairs = [];
        installFidelity(new FidelityService(fake));
        const out = await transformer.transformMessage(reply(true));
        assert.equal(out.fidelity?.replyTo, undefined);
        assert.equal(out.fidelity?.pings?.repliedUser, false);
        assert.equal(out.embeds?.length, 1);
        assert.equal(out.embeds?.[0].toPlainObject().description, 'original');
    });

    it('quotes, and keeps the rest, when the lookup fails', async () => {
        const fake = ports();
        fake.failExists = new Error('fluxer down');
        installFidelity(new FidelityService(fake));
        const out = await transformer.transformMessage(reply(true));
        assert.equal(out.fidelity?.replyTo, undefined);
        assert.equal(out.embeds?.length, 1);
        assert.ok(out.fidelity?.pings, 'pings still apply');
        assert.equal(fake.warnings.length, 1);
    });
});

describe('history copies keep the quote', () => {
    it('never replies natively in a history payload', async () => {
        installFidelity(new FidelityService(ports()));
        const services = {
            linkService: { getGuildLinkById: async () => LINK },
            fluxerEntityResolver: { fetchEmojis: async () => [] },
            commandPrefix: '!',
        } as unknown as UpstreamServices;
        const payload = await new UpstreamBridge(services).payload(
            reply(true),
            LINK.id
        );
        assert.equal(payload.fidelity?.replyTo, undefined);
        assert.equal(payload.embeds?.length, 1);
    });
});

describe('WebhookService native reply', () => {
    it('passes replyTo to the Fluxer webhook send', async () => {
        const sent: Record<string, unknown>[] = [];
        const webhook = {
            send: async (options: Record<string, unknown>) => {
                sent.push(options);
                return { id: 'm1' };
            },
        } as unknown as FluxerWebhook;
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaFluxerWebhook(webhook, {
            content: 'hi',
            username: 'a',
            avatarURL: '',
            fidelity: { replyTo: { channelId: '221', messageId: '401' } },
        });
        assert.deepEqual(sent[0].replyTo, {
            channelId: '221',
            messageId: '401',
        });
    });
});

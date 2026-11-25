import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Webhook as FluxerWebhook, type Client } from '@fluxerjs/core';
import type { WebhookClient } from 'discord.js';
import { installFidelity } from '../../src/relay-extras/fidelity';
import { FidelityService } from '../../src/relay-extras/fidelity/service';
import type { WebhookMessageData } from '../../src/services/WebhookService';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import {
    discordMessage,
    FakePorts,
    fluxerMessage,
    loadWebhookService,
} from './fidelity-fakes';

afterEach(() => installFidelity(null));

type Options = Record<string, unknown>;

interface Call {
    readonly route: string;
    readonly body: Options;
}

/** A real `@fluxerjs/core` webhook whose REST calls are recorded. */
function recordingWebhook(calls: Call[]) {
    const record = async (route: string, options: { body: Options }) => {
        calls.push({ route, body: options.body });
        return { id: 'm1', channel_id: '221', content: '' };
    };
    const client = {
        rest: { post: record, patch: record },
        getOrCreateUser: () => ({}),
    } as unknown as Client;
    return FluxerWebhook.fromToken(client, 'fw', 'ft');
}

function hereMessage(everyone: boolean) {
    return discordMessage({
        content: '@here look',
        mentions: {
            users: new Map(),
            roles: new Map(),
            everyone,
            repliedUser: null,
        },
    });
}

async function sentMentions(data: WebhookMessageData) {
    const calls: Call[] = [];
    const WebhookService = await loadWebhookService();
    const service = new WebhookService();
    const webhook = recordingWebhook(calls);
    await service.sendMessageViaFluxerWebhook(webhook, data);
    await service.editMessageViaFluxerWebhook(webhook, 'm1', data);
    return calls.map((c) => c.body.allowed_mentions);
}

describe('relay without fidelity data', () => {
    const transformer = new DiscordMessageTransformer();

    it('does not let a Discord @here ping Fluxer with the add-ons off', async () => {
        const out = await transformer.transformMessage(hereMessage(false));
        assert.deepEqual(await sentMentions(out), [
            { parse: [], replied_user: false },
            { parse: [], users: [], roles: [], replied_user: false },
        ]);
    });

    it('pings everyone when Discord did, as the thread relay does', async () => {
        const out = await transformer.transformMessage(hereMessage(true));
        const [send] = await sentMentions(out);
        assert.deepEqual(send, { parse: ['everyone'], replied_user: false });
    });

    it('pings no one when a fidelity lookup fails', async () => {
        const ports = new FakePorts();
        ports.failObjectMap = new Error('db down');
        installFidelity(new FidelityService(ports));
        const out = await transformer.transformMessage(hereMessage(false));
        const [send] = await sentMentions(out);
        assert.deepEqual(send, { parse: [], replied_user: false });
    });

    it('pings no one on Discord for a Fluxer message', async () => {
        const out = await new FluxerMessageTransformer().transformMessage(
            fluxerMessage({ content: '@everyone' })
        );
        const calls: Options[] = [];
        const webhook = {
            send: async (options: Options) => {
                calls.push(options);
                return { id: 'm1' };
            },
        } as unknown as WebhookClient;
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaDiscordWebhook(webhook, out);
        assert.deepEqual(calls[0].allowedMentions, {
            parse: [],
            users: [],
            roles: [],
            repliedUser: false,
        });
    });
});

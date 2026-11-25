import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Webhook as FluxerWebhook } from '@fluxerjs/core';
import type { WebhookClient } from 'discord.js';
import {
    UpstreamBridge,
    type UpstreamServices,
} from '../../src/guild-sync/upstreamBridge';
import type { LinkedChannel } from '../../src/guild-sync/links';
import { installFidelity } from '../../src/relay-extras/fidelity';
import { FidelityService } from '../../src/relay-extras/fidelity/service';
import type { WebhookMessageData } from '../../src/services/WebhookService';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import {
    discordMessage,
    FakePorts,
    fluxerMessage,
    LINK,
    loadWebhookService,
} from './fidelity-fakes';

afterEach(() => installFidelity(null));

function install() {
    installFidelity(new FidelityService(new FakePorts()));
}

const users = (...ids: string[]) => new Map(ids.map((id) => [id, {}]));

function pinging(fields: Record<string, unknown>) {
    return discordMessage({
        mentions: {
            users: new Map(),
            roles: new Map(),
            everyone: false,
            repliedUser: null,
            ...fields,
        },
    });
}

describe('fidelity pings, Discord to Fluxer', () => {
    const transformer = new DiscordMessageTransformer();

    it('pings mapped users and roles the source pinged', async () => {
        install();
        const out = await transformer.transformMessage(
            pinging({
                users: users('101', '102'),
                roles: users('111', '112'),
            })
        );
        assert.deepEqual(out.fidelity?.pings, {
            everyone: false,
            users: ['201'],
            roles: ['211'],
            repliedUser: false,
        });
    });

    it('pings everyone only when the source did', async () => {
        install();
        const quiet = await transformer.transformMessage(pinging({}));
        assert.equal(quiet.fidelity?.pings?.everyone, false);
        const loud = await transformer.transformMessage(
            pinging({ everyone: true })
        );
        assert.equal(loud.fidelity?.pings?.everyone, true);
    });
});

describe('fidelity pings, Fluxer to Discord', () => {
    const transformer = new FluxerMessageTransformer();

    it('keeps @everyone whole and pinging only when it was real', async () => {
        install();
        const real = await transformer.transformMessage(
            fluxerMessage({ content: '@everyone', mentionEveryone: true })
        );
        assert.equal(real.content, '@everyone');
        assert.equal(real.fidelity?.pings?.everyone, true);
        const fake = await transformer.transformMessage(
            fluxerMessage({ content: '@everyone' })
        );
        assert.equal(fake.content, '@​everyone');
        assert.equal(fake.fidelity?.pings?.everyone, false);
    });

    it('pings the linked Discord account of a pinged Fluxer user', async () => {
        install();
        const out = await transformer.transformMessage(
            fluxerMessage({
                content: '<@201>',
                mentions: [{ id: '201' }],
                mentionRoles: ['211'],
            })
        );
        assert.deepEqual(out.fidelity?.pings?.users, ['101']);
        assert.deepEqual(out.fidelity?.pings?.roles, ['111']);
    });
});

describe('WebhookService with fork fields', () => {
    const data: WebhookMessageData = {
        content: 'hi',
        username: 'alice',
        avatarURL: '',
        fidelity: {
            pings: {
                everyone: false,
                users: ['201'],
                roles: [],
                repliedUser: false,
            },
        },
    };

    it('passes pings to a Fluxer webhook send', async () => {
        const sent: Record<string, unknown>[] = [];
        const webhook = {
            send: async (options: Record<string, unknown>) => {
                sent.push(options);
                return { id: 'm1' };
            },
        } as unknown as FluxerWebhook;
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaFluxerWebhook(webhook, data);
        assert.deepEqual(sent[0].allowedMentions, {
            parse: [],
            users: ['201'],
            roles: [],
            repliedUser: false,
        });
    });

    it('passes pings to a Discord webhook send and edit', async () => {
        const calls: Record<string, unknown>[] = [];
        const webhook = {
            send: async (options: Record<string, unknown>) => {
                calls.push(options);
                return { id: 'm1' };
            },
            editMessage: async (
                _id: string,
                options: Record<string, unknown>
            ) => calls.push(options),
        } as unknown as WebhookClient;
        const WebhookService = await loadWebhookService();
        const service = new WebhookService();
        await service.sendMessageViaDiscordWebhook(webhook, data);
        await service.editMessageViaDiscordWebhook(webhook, 'm1', data);
        for (const call of calls) {
            assert.deepEqual(call.allowedMentions, {
                parse: [],
                users: ['201'],
                roles: [],
                repliedUser: false,
            });
        }
    });

    it('sends no allowedMentions for an upstream payload', async () => {
        const calls: Record<string, unknown>[] = [];
        const webhook = {
            send: async (options: Record<string, unknown>) => {
                calls.push(options);
                return { id: 'm1' };
            },
        } as unknown as WebhookClient;
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaDiscordWebhook(webhook, {
            content: 'hi',
            username: 'a',
            avatarURL: '',
        });
        assert.equal('allowedMentions' in calls[0], false);
    });
});

const THREAD_LINK: LinkedChannel = {
    id: 'cl',
    guildLinkId: LINK.id,
    discordChannelId: '121',
    fluxerChannelId: '221',
    discordWebhook: { id: 'dw', token: 'dt' },
    fluxerWebhook: { id: 'fw', token: 'ft' },
};

function bridgeRecording(sent: WebhookMessageData[], starter?: unknown) {
    const services = {
        discordClient: {
            user: null,
            channels: {
                fetch: async () => ({
                    isThread: () => true,
                    fetchStarterMessage: async () => starter,
                }),
            },
        },
        fluxerClientRef: {
            current: {
                isReady: () => true,
                rest: {},
                getOrCreateUser: () => ({}),
            },
        },
        linkService: {
            getGuildLinkById: async () => LINK,
            getGuildLinkForDiscordGuild: async () => LINK,
        },
        fluxerEntityResolver: { fetchEmojis: async () => [] },
        webhookService: {
            sendMessageViaFluxerWebhook: async (
                _hook: unknown,
                payload: WebhookMessageData
            ) => {
                sent.push(payload);
                return { messageId: 'f-copy' };
            },
        },
        commandPrefix: '!',
    } as unknown as UpstreamServices;
    return new UpstreamBridge(services);
}

describe('thread relay pings', () => {
    it('pings @everyone without fidelity only when Discord did', async () => {
        const sent: WebhookMessageData[] = [];
        const bridge = bridgeRecording(sent);
        await bridge.send(
            'fluxer',
            THREAD_LINK,
            '122',
            pinging({ everyone: true })
        );
        await bridge.send('fluxer', THREAD_LINK, '122', pinging({}));
        assert.equal(sent[0].fidelity?.pings?.everyone, true);
        assert.equal(sent[1].fidelity?.pings?.everyone, false);
    });

    it('pings the mapped users a Discord thread reply pinged', async () => {
        install();
        const sent: WebhookMessageData[] = [];
        await bridgeRecording(sent).send(
            'fluxer',
            THREAD_LINK,
            '122',
            pinging({ users: users('101') })
        );
        assert.deepEqual(sent[0].fidelity?.pings?.users, ['201']);
    });

    it('lets a forum starter ping no one', async () => {
        install();
        const starter = pinging({ users: users('101'), everyone: true });
        Object.assign(starter, { createdTimestamp: Date.now() });
        const payload = await bridgeRecording([], starter).starter(
            LINK.discordGuildId,
            '122'
        );
        assert.deepEqual(payload.fidelity?.pings, {
            everyone: false,
            users: [],
            roles: [],
            repliedUser: false,
        });
    });
});

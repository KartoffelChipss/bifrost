import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Webhook as FluxerWebhook, type Client } from '@fluxerjs/core';
import { MessageType } from 'discord.js';
import { installFidelity } from '../../src/relay-extras/fidelity';
import { rejectedField } from '../../src/relay-extras/fidelity/fallback';
import { fluxerEditFields } from '../../src/relay-extras/fidelity/send';
import { FidelityService } from '../../src/relay-extras/fidelity/service';
import type { MessagePair } from '../../src/relay-extras/types';
import WebhookEmbed from '../../src/services/WebhookEmbed';
import type {
    WebhookMessageData,
    WebhookService,
} from '../../src/services/WebhookService';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import { buildDiscordStickerUrl } from '../../src/utils/buildStickerUrl';
import {
    discordMessage,
    FakePorts,
    LINK,
    fetchedUrls,
    loadWebhookService,
} from './fidelity-fakes';

afterEach(() => installFidelity(null));

const STICKER_URL = buildDiscordStickerUrl('141', 160);
const QUOTE = new WebhookEmbed({ description: 'original', color: 0x0b0d0e });

/** A copy that replies natively and sends a native sticker. */
function nativeCopy(): WebhookMessageData {
    return {
        content: 'hi',
        username: 'alice',
        avatarURL: '',
        embeds: [],
        attachments: [{ url: 'https://cdn/file.png', name: 'file.png' }],
        fidelity: {
            pings: {
                everyone: false,
                users: ['201'],
                roles: [],
                repliedUser: true,
            },
            replyTo: { channelId: '221', messageId: '401' },
            replyQuote: QUOTE.toPlainObject(),
            stickerIds: ['241'],
            stickerImages: [{ url: STICKER_URL, name: 'cat.png' }],
        },
    };
}

/** Shaped like `@fluxerjs/rest` FluxerAPIError (request-manager.js). */
function apiError(statusCode: number, code: string, errors?: unknown[]) {
    return Object.assign(new Error(code), {
        name: 'FluxerAPIError',
        statusCode,
        code,
        errors,
    });
}

const GONE = () => apiError(404, 'UNKNOWN_MESSAGE');
const NO_STICKER = () =>
    apiError(400, 'INVALID_FORM_BODY', [
        {
            path: 'sticker',
            code: 'CUSTOM_STICKER_NOT_FOUND',
            message: 'x',
        },
    ]);
const DOWN = () => apiError(503, 'SERVICE_UNAVAILABLE');

type Options = Record<string, unknown>;

/** A Fluxer webhook whose sends throw the scripted errors in turn. */
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

const descriptions = (embeds: unknown) =>
    (embeds as { toJSON(): { description?: string } }[]).map(
        (e) => e.toJSON().description
    );

const fileUrls = fetchedUrls;

describe('rejectedField', () => {
    const fidelity = nativeCopy().fidelity;

    it('names the reply for a missing or system reply target', () => {
        assert.equal(rejectedField(GONE(), fidelity), 'replyTo');
        const system = apiError(400, 'INVALID_FORM_BODY', [
            { path: 'message_reference', code: 'CANNOT_REPLY' },
        ]);
        assert.equal(rejectedField(system, fidelity), 'replyTo');
    });

    it('names the stickers for an unknown or malformed sticker', () => {
        assert.equal(rejectedField(NO_STICKER(), fidelity), 'stickerIds');
        const malformed = apiError(400, 'INVALID_FORM_BODY', [
            { path: 'sticker_ids.0', code: 'X' },
        ]);
        assert.equal(rejectedField(malformed, fidelity), 'stickerIds');
    });

    it('names nothing for a transient or unrelated failure', () => {
        assert.equal(rejectedField(DOWN(), fidelity), null);
        assert.equal(
            rejectedField(new Error('socket hang up'), fidelity),
            null
        );
        assert.equal(
            rejectedField(apiError(429, 'RATE_LIMITED'), fidelity),
            null
        );
        const perms = apiError(403, 'MISSING_PERMISSIONS');
        assert.equal(rejectedField(perms, fidelity), null);
    });

    it('names nothing the payload does not carry', () => {
        assert.equal(rejectedField(GONE(), { pings: fidelity?.pings }), null);
        assert.equal(rejectedField(NO_STICKER(), undefined), null);
    });
});

describe('Fluxer send fallback', () => {
    it('resends with the quote when the replied-to message is gone', async () => {
        const { webhook, sent } = scripted([GONE(), null]);
        const WebhookService = await loadWebhookService();
        const result = await new WebhookService().sendMessageViaFluxerWebhook(
            webhook,
            nativeCopy()
        );
        assert.equal(result.messageId, 'm2');
        assert.equal(sent.length, 2);
        assert.ok(sent[0].replyTo);
        assert.equal(sent[1].replyTo, undefined);
        assert.deepEqual(descriptions(sent[1].embeds), ['original']);
        assert.equal(
            (sent[1].allowedMentions as Options).repliedUser,
            false,
            'no reply, no reply ping'
        );
        assert.deepEqual(sent[1].stickerIds, ['241']);
    });

    it('resends with the sticker images when a sticker is unknown', async () => {
        const { webhook, sent } = scripted([NO_STICKER(), null]);
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaFluxerWebhook(
            webhook,
            nativeCopy()
        );
        assert.equal(sent[1].stickerIds, undefined);
        assert.deepEqual(fileUrls(sent[1].files), [
            'https://cdn/file.png',
            STICKER_URL,
        ]);
        assert.ok(sent[1].replyTo, 'the reply stays');
    });

    it('drops both when Fluxer rejects both', async () => {
        const { webhook, sent } = scripted([GONE(), NO_STICKER(), null]);
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaFluxerWebhook(
            webhook,
            nativeCopy()
        );
        assert.equal(sent.length, 3);
        assert.equal(sent[2].replyTo, undefined);
        assert.equal(sent[2].stickerIds, undefined);
    });

    it('sends once and keeps the payload for a transient failure', async () => {
        const { webhook, sent } = scripted([DOWN()]);
        const WebhookService = await loadWebhookService();
        const copy = nativeCopy();
        const result = await new WebhookService().sendCopyViaFluxerWebhook(
            webhook,
            copy
        );
        assert.equal(result.ok, false);
        assert.equal(result.payload, copy);
        assert.equal(sent.length, 1);
    });

    it('returns the payload without the rejected field when the retry fails', async () => {
        const { webhook } = scripted([GONE(), DOWN(), DOWN(), DOWN(), DOWN()]);
        const WebhookService = await loadWebhookService();
        const service = new WebhookService();
        const result = await service.sendCopyViaFluxerWebhook(
            webhook,
            nativeCopy()
        );
        assert.equal(result.ok, false);
        assert.equal(result.payload.fidelity?.replyTo, undefined);
        assert.equal(result.payload.fidelity?.replyQuote, undefined);
        assert.deepEqual(
            descriptions(result.payload.embeds?.map((e) => e.toFluxerEmbed())),
            ['original']
        );
        await assert.rejects(
            service.sendMessageViaFluxerWebhook(
                scripted([DOWN()]).webhook,
                nativeCopy()
            ),
            /SERVICE_UNAVAILABLE/
        );
    });
});

const CHANNEL_LINK = {
    id: 'cl',
    linkId: 'l',
    guildLinkId: LINK.id,
    discordChannelId: '121',
    fluxerChannelId: '221',
    fluxerWebhookId: 'fw',
    fluxerWebhookToken: 'ft',
};

async function serviceWith(webhook: FluxerWebhook): Promise<WebhookService> {
    const WebhookService = await loadWebhookService();
    const service = new WebhookService();
    service.getFluxerWebhook = async () => webhook;
    return service;
}

async function relayQueueing(webhook: FluxerWebhook, queued: unknown[]) {
    const { default: Relay } =
        await import('../../src/services/messageRelay/DiscordToFluxerMessageRelay');
    const deps = {
        linkService: {
            getChannelLinkByDiscordChannelId: async () => CHANNEL_LINK,
            getGuildLinkById: async () => LINK,
            createMessageLink: async () => undefined,
        },
        webhookService: await serviceWith(webhook),
        messageTransformer: { transformMessage: async () => nativeCopy() },
        queueService: {
            enqueue: async (...args: unknown[]) => queued.push(args[3]),
        },
        fluxerEntityResolver: { fetchEmojis: async () => [] },
    };
    return new Relay(deps as unknown as ConstructorParameters<typeof Relay>[0]);
}

const relayed = { id: 'd1', channelId: '121', type: MessageType.Default };

describe('queued copies with fork fields', () => {
    it('queues a failed copy without the reply Fluxer rejected', async () => {
        const queued: WebhookMessageData[] = [];
        const { webhook } = scripted([GONE(), DOWN(), DOWN(), DOWN(), DOWN()]);
        const relay = await relayQueueing(webhook, queued);
        await relay.relayMessage(relayed as never);
        assert.equal(queued.length, 1);
        assert.equal(queued[0].fidelity?.replyTo, undefined);
        assert.deepEqual(
            (queued[0].embeds as unknown as { description: string }[]).map(
                (e) => e.description
            ),
            ['original']
        );
        assert.deepEqual(queued[0].fidelity?.stickerIds, ['241']);
    });

    it('queues the fork fields of a copy that failed for a while', async () => {
        const queued: WebhookMessageData[] = [];
        const relay = await relayQueueing(scripted([DOWN()]).webhook, queued);
        await relay.relayMessage(relayed as never);
        const restored = JSON.parse(JSON.stringify(queued[0]));
        assert.deepEqual(restored.fidelity, nativeCopy().fidelity);
    });

    it('retries a queued copy with its fork fields', async () => {
        const { webhook, sent } = scripted([null]);
        const run = await drainOnce(webhook);
        assert.deepEqual(sent[0].replyTo, {
            channelId: '221',
            messageId: '401',
        });
        assert.deepEqual(sent[0].stickerIds, ['241']);
        assert.deepEqual((sent[0].allowedMentions as Options).users, ['201']);
        assert.equal(run.destroyed, true);
        assert.equal(run.links.length, 1);
    });

    it('rewrites a queued entry without the field Fluxer rejected', async () => {
        const { webhook, sent } = scripted([
            GONE(),
            DOWN(),
            DOWN(),
            DOWN(),
            DOWN(),
        ]);
        const run = await drainOnce(webhook);
        assert.equal(sent.length, 4);
        const rewrite = run.updates.find((u) => 'payload' in u);
        assert.ok(rewrite, 'the entry payload is rewritten');
        const stored = JSON.parse(rewrite.payload as string);
        assert.equal(stored.fidelity.replyTo, undefined);
        assert.equal(stored.embeds[0].description, 'original');
        assert.equal(run.destroyed, false);
        assert.ok(run.updates.some((u) => u.retryCount === 1));
    });
});

/** Runs one queue drain over one queued copy of nativeCopy(). */
async function drainOnce(webhook: FluxerWebhook) {
    await loadWebhookService();
    const queue = await import('../../src/services/MessageQueueService');
    const { QueuedMessageModel } =
        await import('../../src/db/models/QueuedMessageModel');
    const run = {
        updates: [] as Record<string, unknown>[],
        links: [] as unknown[],
        destroyed: false,
    };
    const entry = {
        id: 'q1',
        direction: 'discord_to_fluxer',
        channelLinkId: 'cl',
        sourceMessageId: 'd1',
        retryCount: 0,
        payload: JSON.stringify(queue.toSerializable(nativeCopy())),
        update: async (fields: Record<string, unknown>) => {
            run.updates.push(fields);
        },
        destroy: async () => {
            run.destroyed = true;
        },
    };
    const model = QueuedMessageModel as unknown as Record<string, unknown>;
    const saved = { destroy: model.destroy, findAll: model.findAll };
    model.destroy = async () => 0;
    model.findAll = async () => [entry];
    try {
        const linkService = {
            getChannelLinkById: async () => CHANNEL_LINK,
            createMessageLink: async (link: unknown) => run.links.push(link),
        };
        await new queue.default(60_000).drain(
            await serviceWith(webhook),
            linkService as never
        );
    } finally {
        Object.assign(model, saved);
    }
    return run;
}

interface EditCall {
    readonly route: string;
    readonly body: Options;
}

/** A Fluxer webhook over a REST stub: GET returns `copy` or throws it. */
function editWebhook(copy: unknown, patches: EditCall[], gets: string[]) {
    const client = {
        rest: {
            get: async (route: string) => {
                gets.push(route);
                if (copy instanceof Error) throw copy;
                return copy;
            },
            patch: async (route: string, options: { body: Options }) => {
                patches.push({ route, body: options.body });
                return {};
            },
        },
        getOrCreateUser: () => ({}),
    } as unknown as Client;
    return FluxerWebhook.fromToken(client, 'fw', 'ft');
}

async function editWith(copy: unknown, data: WebhookMessageData) {
    const patches: EditCall[] = [];
    const gets: string[] = [];
    const WebhookService = await loadWebhookService();
    await new WebhookService().editMessageViaFluxerWebhook(
        editWebhook(copy, patches, gets),
        'm9',
        data
    );
    return { body: patches[0].body, gets };
}

/** The PATCH body holds EmbedBuilders until the REST layer serializes it. */
const editDescriptions = (body: Options) => descriptions(body.embeds);

describe("Fluxer edits keep the copy's rendering", () => {
    it('keeps the quote when the copy was sent with it', async () => {
        const { body, gets } = await editWith(
            { id: 'm9', message_reference: null },
            nativeCopy()
        );
        assert.deepEqual(gets, ['/webhooks/fw/ft/messages/m9']);
        assert.deepEqual(editDescriptions(body), ['original']);
    });

    it('leaves the quote out when the copy is a native reply', async () => {
        const { body } = await editWith(
            { id: 'm9', message_reference: { message_id: '401' } },
            nativeCopy()
        );
        assert.deepEqual(editDescriptions(body), []);
    });

    it('keeps the quote when the copy cannot be read', async () => {
        const { body } = await editWith(new Error('down'), nativeCopy());
        assert.deepEqual(editDescriptions(body), ['original']);
    });

    it('keeps sticker images in their place without reading the copy', async () => {
        const copy = nativeCopy();
        const { body, gets } = await editWith(null, {
            ...copy,
            fidelity: {
                stickerIds: copy.fidelity?.stickerIds,
                stickerImages: copy.fidelity?.stickerImages,
            },
        });
        assert.deepEqual(gets, []);
        assert.deepEqual(
            (body.attachments as { id: number; filename: string }[]).map(
                (a) => [a.id, a.filename]
            ),
            [
                [0, 'file.png'],
                [1, 'cat.png'],
            ]
        );
    });

    it('keeps the quote aside when an edit replies natively', async () => {
        const fake = new FakePorts();
        const pair: MessagePair = {
            guildLinkId: LINK.id,
            discord: { channelId: '121', messageId: '301' },
            fluxer: { channelId: '221', messageId: '401' },
        };
        fake.pairs = [pair];
        installFidelity(new FidelityService(fake));
        const author = { id: '102', username: 'bob', avatarURL: () => null };
        const out = await new DiscordMessageTransformer().transformMessage(
            discordMessage({
                type: MessageType.Reply,
                flags: { has: () => false },
                reference: { messageId: '301', channelId: '121' },
                fetchReference: async () =>
                    discordMessage({ id: '301', content: 'original', author }),
            })
        );
        assert.deepEqual(out.embeds, []);
        assert.equal(out.fidelity?.replyQuote?.description, 'original');
    });
});

describe('fluxerEditFields', () => {
    it('writes the pings as a raw allowed_mentions body field', () => {
        assert.deepEqual(
            fluxerEditFields({
                pings: {
                    everyone: false,
                    users: ['201'],
                    roles: ['211'],
                    repliedUser: true,
                },
            }),
            {
                allowed_mentions: {
                    parse: [],
                    users: ['201'],
                    roles: ['211'],
                    replied_user: true,
                },
            }
        );
    });

    it('parses everyone alone when the copy pings everyone', () => {
        const fields = fluxerEditFields({
            pings: {
                everyone: true,
                users: ['201'],
                roles: [],
                repliedUser: false,
            },
        });
        assert.deepEqual(fields, {
            allowed_mentions: { parse: ['everyone'], replied_user: false },
        });
    });

    it('adds nothing without pings', () => {
        assert.deepEqual(fluxerEditFields(undefined), {});
        assert.deepEqual(fluxerEditFields({ stickerIds: ['241'] }), {});
    });
});

/** A real `@fluxerjs/core` webhook whose REST calls are recorded. */
function recordingWebhook(calls: EditCall[]) {
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

describe('real @fluxerjs/core request bodies', () => {
    it('sends replyTo, stickerIds and pings as Fluxer fields', async () => {
        const calls: EditCall[] = [];
        const WebhookService = await loadWebhookService();
        await new WebhookService().sendMessageViaFluxerWebhook(
            recordingWebhook(calls),
            { ...nativeCopy(), attachments: [] }
        );
        const { body } = calls[0];
        assert.equal(calls[0].route, '/webhooks/fw/ft?wait=true');
        assert.deepEqual(body.message_reference, {
            channel_id: '221',
            message_id: '401',
        });
        assert.deepEqual(body.sticker_ids, ['241']);
        assert.deepEqual(body.allowed_mentions, {
            parse: [],
            users: ['201'],
            replied_user: true,
        });
        assert.equal('replyQuote' in body, false);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@fluxerjs/core';
import {
    copyWebhook,
    quietClient,
    withoutMentions,
} from '../../src/history/quietWebhook';

interface Call {
    readonly method: string;
    readonly route: string;
    readonly options: Record<string, unknown>;
}

function fakeClient(calls: Call[]): Client {
    const record =
        (method: string) =>
        async (route: string, options: Record<string, unknown> = {}) => {
            calls.push({ method, route, options });
            return { id: 'm1', channel_id: 'c1', content: '' };
        };
    return {
        rest: {
            post: record('post'),
            patch: record('patch'),
            delete: record('delete'),
            get: record('get'),
        },
        // The library's webhook constructor asks the client for a user.
        getOrCreateUser: () => ({}),
    } as unknown as Client;
}

describe('quiet webhooks', () => {
    it('adds allowed_mentions with nothing parsed to POST and PATCH bodies', async () => {
        const calls: Call[] = [];
        const client = quietClient(fakeClient(calls));
        await client.rest.post('/webhooks/1/t', {
            body: { content: '@everyone' },
        });
        await client.rest.patch('/webhooks/1/t/messages/2', {
            body: { content: 'x' },
        });
        await client.rest.delete('/webhooks/1/t/messages/2');
        assert.deepEqual(
            calls.map(
                (c) =>
                    (c.options.body as { allowed_mentions?: unknown })
                        ?.allowed_mentions
            ),
            [{ parse: [] }, { parse: [] }, undefined]
        );
    });

    it('leaves a non-JSON body alone', () => {
        const form = new Map();
        assert.equal(withoutMentions({ body: form }).body, form);
    });

    it('sends through the thread proxy with the thread and no mentions', async () => {
        const calls: Call[] = [];
        const hook = copyWebhook(fakeClient(calls), {
            webhook: { id: '1', token: 't' },
            threadId: '77',
        });
        await hook.send({ content: '@here hi' });
        assert.match(calls[0].route, /thread_id=77/);
        assert.deepEqual(
            (calls[0].options.body as { allowed_mentions: unknown })
                .allowed_mentions,
            { parse: [] }
        );
    });
});

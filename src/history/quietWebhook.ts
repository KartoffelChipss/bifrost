import { Webhook, type Client } from '@fluxerjs/core';
import { fluxerThreadWebhook } from '../guild-sync/threadWebhook';
import type { SendTarget } from './types';

/**
 * Webhooks for history copies that never ping anyone. An imported message
 * may contain @everyone, @here, role or user mentions from years ago.
 * Fluxer extracts mentions from webhook content and applies the request's
 * `allowed_mentions` (fluxer_api MessageSendService sendWebhookMessage,
 * MessageMentionService applyAllowedMentions). Upstream's send helper sets
 * none, so this wrapper adds `{ parse: [] }` to every POST and PATCH body.
 */

/** Fluxer's allowed_mentions body field: parse nothing, ping no one. */
export const NO_MENTIONS: { readonly parse: readonly string[] } = {
    parse: [],
};

type RestCall = (route: string, options?: Record<string, unknown>) => unknown;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) return false;
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** Request options whose JSON body carries allowed_mentions. */
export function withoutMentions(
    options: Record<string, unknown>
): Record<string, unknown> {
    const body = options.body ?? {};
    if (!isPlainObject(body)) return options;
    return { ...options, body: { ...body, allowed_mentions: NO_MENTIONS } };
}

/** A view of the client whose POST and PATCH requests ping no one. */
export function quietClient(client: Client): Client {
    const rest = new Proxy(client.rest, {
        get(original, property, receiver) {
            const value: unknown = Reflect.get(original, property, receiver);
            const quiet = property === 'post' || property === 'patch';
            if (!quiet || typeof value !== 'function') return value;
            const call = value.bind(original) as RestCall;
            return (route: string, options: Record<string, unknown> = {}) =>
                call(route, withoutMentions(options));
        },
    });
    return Object.create(client, { rest: { value: rest } }) as Client;
}

/** The webhook a copy is sent through, aimed at its thread if it has one. */
export function copyWebhook(client: Client, target: SendTarget): Webhook {
    const quiet = quietClient(client);
    return target.threadId
        ? fluxerThreadWebhook(quiet, target.webhook, {
              threadId: target.threadId,
          })
        : Webhook.fromToken(quiet, target.webhook.id, target.webhook.token);
}

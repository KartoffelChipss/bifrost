import { Webhook, type Client } from '@fluxerjs/core';
import type { WebhookClient } from 'discord.js';
import type { WebhookRef } from './links';

/**
 * Webhooks aimed at a thread. Upstream's send and edit helpers know only
 * channels, and `@fluxerjs/core` 3.3.0 has no thread option on a webhook.
 * These wrappers add the thread to the request, so upstream's helpers,
 * with their file and embed handling, work unchanged.
 */

/** Where a Fluxer webhook call goes: an existing thread or a new post. */
export type FluxerThreadTarget =
    | { readonly threadId: string }
    | {
          readonly threadName: string;
          readonly appliedTags: readonly string[];
      };

function withThreadQuery(route: string, threadId: string): string {
    const separator = route.includes('?') ? '&' : '?';
    return `${route}${separator}thread_id=${encodeURIComponent(threadId)}`;
}

type RestCall = (route: string, options?: Record<string, unknown>) => unknown;

/**
 * A Fluxer webhook whose requests carry the thread. Fluxer takes
 * `thread_id` as a query parameter, and `thread_name` with `applied_tags`
 * in the body to start a forum post (WebhookRequestSchemas.ts).
 */
export function fluxerThreadWebhook(
    client: Client,
    ref: WebhookRef,
    target: FluxerThreadTarget
): Webhook {
    const aim = (call: RestCall): RestCall => {
        return (route, options = {}) => {
            if ('threadId' in target) {
                return call(withThreadQuery(route, target.threadId), options);
            }
            const body = (options.body ?? {}) as Record<string, unknown>;
            return call(route, {
                ...options,
                body: {
                    ...body,
                    thread_name: target.threadName,
                    applied_tags: [...target.appliedTags],
                },
            });
        };
    };
    const rest = new Proxy(client.rest, {
        get(original, property, receiver) {
            const value = Reflect.get(original, property, receiver);
            const aimed =
                property === 'post' ||
                property === 'patch' ||
                property === 'delete';
            if (!aimed || typeof value !== 'function') return value;
            return aim(value.bind(original) as RestCall);
        },
    });
    const scoped = Object.create(client, { rest: { value: rest } }) as Client;
    return Webhook.fromToken(scoped, ref.id, ref.token);
}

/** A Discord webhook client whose sends and edits go to one thread. */
export function discordThreadWebhook(
    webhook: WebhookClient,
    threadId: string
): WebhookClient {
    const scoped = Object.create(webhook) as WebhookClient;
    scoped.send = ((options: unknown) =>
        webhook.send(
            typeof options === 'string'
                ? { content: options, threadId }
                : { ...(options as object), threadId }
        )) as WebhookClient['send'];
    scoped.editMessage = ((message: string, options: unknown) =>
        webhook.editMessage(message, {
            ...(options as object),
            threadId,
        })) as WebhookClient['editMessage'];
    return scoped;
}

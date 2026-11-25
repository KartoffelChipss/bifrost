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

/**
 * `allowed_mentions` for a Fluxer copy of a Discord message. Upstream's
 * transformer writes user and role mentions as plain `@name` text, so
 * only `@everyone` and `@here` could ping. They may ping only when the
 * Discord message really mentioned everyone: Discord sets that only when
 * the author may mention everyone. Fluxer reads `allowed_mentions` on
 * webhook execute and edit (WebhookService.ts, MessageEditService.ts).
 */
export function fluxerAllowedMentions(raw: unknown): {
    parse: 'everyone'[];
} {
    const mentions = (raw as { mentions?: { everyone?: unknown } } | null)
        ?.mentions;
    return { parse: mentions?.everyone === true ? ['everyone'] : [] };
}

function withThreadQuery(route: string, threadId: string): string {
    const separator = route.includes('?') ? '&' : '?';
    return `${route}${separator}thread_id=${encodeURIComponent(threadId)}`;
}

type RestCall = (route: string, options?: Record<string, unknown>) => unknown;

/** Body fields a thread target adds: none for a thread, a post's name. */
function targetBody(target: FluxerThreadTarget): Record<string, unknown> {
    if ('threadId' in target) return {};
    return {
        thread_name: target.threadName,
        applied_tags: [...target.appliedTags],
    };
}

/**
 * A Fluxer webhook whose requests carry the thread. Fluxer takes
 * `thread_id` as a query parameter, and `thread_name` with `applied_tags`
 * in the body to start a forum post (WebhookRequestSchemas.ts). `extra`
 * fields, such as `allowed_mentions`, join every send and edit body.
 */
export function fluxerThreadWebhook(
    client: Client,
    ref: WebhookRef,
    target: FluxerThreadTarget,
    extra: Record<string, unknown> = {}
): Webhook {
    const fields = { ...extra, ...targetBody(target) };
    const addsBody = Object.keys(fields).length > 0;
    const aim = (call: RestCall, withBody: boolean): RestCall => {
        return (route, options = {}) => {
            const aimed =
                'threadId' in target
                    ? withThreadQuery(route, target.threadId)
                    : route;
            if (!withBody || !addsBody) return call(aimed, options);
            const body = (options.body ?? {}) as Record<string, unknown>;
            return call(aimed, { ...options, body: { ...body, ...fields } });
        };
    };
    const rest = new Proxy(client.rest, {
        get(original, property, receiver) {
            const value = Reflect.get(original, property, receiver);
            if (typeof value !== 'function') return value;
            const bound = value.bind(original) as RestCall;
            if (property === 'post' || property === 'patch') {
                return aim(bound, true);
            }
            return property === 'delete' ? aim(bound, false) : value;
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

/**
 * A Discord webhook client whose next send starts a forum post. Discord
 * names the post's thread in the response's `channel_id`, which upstream's
 * helper drops, so `threadId()` keeps it.
 */
export function discordPostWebhook(
    webhook: WebhookClient,
    post: { readonly threadName: string; readonly appliedTags: string[] }
): { client: WebhookClient; threadId: () => string | null } {
    let created: string | null = null;
    const scoped = Object.create(webhook) as WebhookClient;
    scoped.send = (async (options: unknown) => {
        const body =
            typeof options === 'string' ? { content: options } : options;
        const sent = await webhook.send({
            ...(body as object),
            threadName: post.threadName,
            appliedTags: post.appliedTags,
        });
        created = sent.channel_id;
        return sent;
    }) as WebhookClient['send'];
    return { client: scoped, threadId: () => created };
}

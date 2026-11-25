import type { CopyFidelity, PingSpec } from './types';

/**
 * Turns a payload's fork fields into the options each platform's webhook
 * call takes. Upstream's WebhookService spreads these into its calls, so
 * a payload without fork fields is sent exactly as before.
 */

/** Both platforms take at most 100 user and 100 role IDs. */
export const MAX_ALLOWED_IDS = 100;

/**
 * Fluxer rejects a non-empty `parse` together with `users` or `roles`
 * (MessageMentionService.ts, PARSE_AND_USERS_OR_ROLES_CANNOT_BE_USED_TOGETHER).
 * Pinging everyone reaches every member anyway, so it wins.
 */
function fluxerMentions(pings: PingSpec) {
    if (pings.everyone) {
        return { parse: ['everyone' as const], repliedUser: pings.repliedUser };
    }
    return {
        parse: [],
        users: pings.users.slice(0, MAX_ALLOWED_IDS),
        roles: pings.roles.slice(0, MAX_ALLOWED_IDS),
        repliedUser: pings.repliedUser,
    };
}

/**
 * Options for `@fluxerjs/core` Webhook.send. Its typings name only some
 * fields, but send passes the rest to prepareMessagePostPayload, which
 * maps `replyTo` to `message_reference` and `stickerIds` to `sticker_ids`
 * (dist/index.js). Fluxer's webhook schema takes both
 * (WebhookRequestSchemas.ts).
 */
export function fluxerSendFields(fidelity: CopyFidelity | undefined) {
    if (!fidelity) return {};
    return {
        ...(fidelity.pings
            ? { allowedMentions: fluxerMentions(fidelity.pings) }
            : {}),
        ...(fidelity.replyTo ? { replyTo: { ...fidelity.replyTo } } : {}),
        ...(fidelity.stickerIds?.length
            ? { stickerIds: [...fidelity.stickerIds] }
            : {}),
    };
}

/** The raw `allowed_mentions` body field of a Fluxer webhook edit. */
export function fluxerEditFields(fidelity: CopyFidelity | undefined) {
    if (!fidelity?.pings) return {};
    const { repliedUser, ...rest } = fluxerMentions(fidelity.pings);
    return { allowed_mentions: { ...rest, replied_user: repliedUser } };
}

/**
 * discord.js `allowedMentions` for a webhook send or edit. Discord
 * webhooks ping every mention in the text unless told otherwise.
 */
export function discordSendFields(fidelity: CopyFidelity | undefined) {
    const pings = fidelity?.pings;
    if (!pings) return {};
    return {
        allowedMentions: {
            parse: pings.everyone ? ['everyone' as const] : [],
            users: pings.users.slice(0, MAX_ALLOWED_IDS),
            roles: pings.roles.slice(0, MAX_ALLOWED_IDS),
            repliedUser: pings.repliedUser,
        },
    };
}

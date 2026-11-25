import type { Side } from './types';

/**
 * Fluxer takes webhook names of 1 to 80 characters (WebhookNameType,
 * packages/schema/src/primitives/UserValidators.ts). Discord documents
 * the same range for webhook names.
 */
export const MAX_WEBHOOK_NAME = 80;

/** Discord's documented webhook name rule: neither word may appear. */
const DISCORD_RESERVED = /discord|clyde/i;

/**
 * The display name to post a copy under, or null to keep upstream's
 * username: when there is none, or the target would refuse it. The
 * fallback is exactly what upstream sends today.
 */
export function webhookName(name: string | null, target: Side): string | null {
    const trimmed = name?.trim() ?? '';
    if (trimmed === '' || trimmed.length > MAX_WEBHOOK_NAME) return null;
    if (target === 'discord' && DISCORD_RESERVED.test(trimmed)) return null;
    return trimmed;
}

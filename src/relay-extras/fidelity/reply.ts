import { otherSide } from '../types';
import type { FidelityPorts, SourceFacts, TargetMessageRef } from './types';

/**
 * The counterpart a copy can natively reply to, or null to keep upstream's
 * quote embed.
 *
 * Only Fluxer webhooks take a reply: Discord's execute-webhook body has no
 * `message_reference` (discord-api-types rest/v10/webhook.d.ts,
 * RESTPostAPIWebhookWithTokenJSONBody). Fluxer looks a webhook reply's
 * message up in the webhook's own channel or thread and fails the send
 * when it is not there (MessageSendService.ts sendWebhookMessage,
 * UnknownMessageError), so the counterpart must sit in the copy's target
 * channel and still exist.
 */
export async function replyTarget(
    facts: SourceFacts,
    guildLinkId: string,
    targetChannelId: string | undefined,
    ports: Pick<FidelityPorts, 'findPair' | 'messageExists'>
): Promise<TargetMessageRef | null> {
    const target = otherSide(facts.side);
    if (!facts.reply || target !== 'fluxer' || !targetChannelId) return null;
    const pair = await ports.findPair(facts.side, facts.reply.messageId);
    if (!pair || pair.guildLinkId !== guildLinkId) return null;
    const counterpart = pair[target];
    if (counterpart.channelId !== targetChannelId) return null;
    const exists = await ports.messageExists(
        target,
        counterpart.channelId,
        counterpart.messageId
    );
    return exists
        ? { channelId: counterpart.channelId, messageId: counterpart.messageId }
        : null;
}

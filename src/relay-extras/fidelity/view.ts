import type { WebhookMessageData } from '../../services/WebhookService';
import { breakMentions } from '../../utils/sanitizeMentions';
import {
    breakUnpinged,
    mapEmojis,
    mapMentionToken,
    type MentionMaps,
} from './mentions';
import type { FidelityView, PingSpec, Side, SourceFacts } from './types';

/** A copy that pings nobody. */
export const NO_PINGS: PingSpec = {
    everyone: false,
    users: [],
    roles: [],
    repliedUser: false,
};

/** Everything the service looked up for one source message. */
export interface Resolution {
    readonly facts: SourceFacts;
    readonly target: Side;
    readonly mentions: MentionMaps;
    readonly emojis: ReadonlyMap<string, string>;
}

/** Upstream's behaviour: flat mentions, upstream's payload unchanged. */
export const NO_FIDELITY: FidelityView = {
    mention: () => null,
    emojis: (content) => content,
    breakMentions,
    finish: (payload) => payload,
};

function finishWith(
    payload: WebhookMessageData,
    pings: PingSpec
): WebhookMessageData {
    return { ...payload, fidelity: { ...payload.fidelity, pings } };
}

/** The view a transformer reads while it builds one copy. */
export function createView(resolution: Resolution): FidelityView {
    const pings = NO_PINGS;
    return {
        mention: (token) => mapMentionToken(token, resolution.mentions),
        emojis: (content, targetEmojis) =>
            mapEmojis(content, resolution.emojis, targetEmojis),
        breakMentions: (content) => breakUnpinged(content, pings.everyone),
        finish: (payload) => finishWith(payload, pings),
    };
}

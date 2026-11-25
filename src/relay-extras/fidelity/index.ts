import type { FidelityService } from './service';
import {
    discordFacts,
    fluxerFacts,
    type DiscordSource,
    type FluxerSource,
} from './sources';
import type { FidelityView, SourceFacts } from './types';
import { NO_FIDELITY } from './view';

/**
 * The hooks upstream's message transformers call. Upstream builds its
 * transformers in src/discord.ts, src/fluxer.ts and upstreamBridge.ts
 * without a way to pass dependencies, so the service is installed here
 * when the relay extras start and removed when they stop. Without it
 * every hook returns NO_FIDELITY: upstream's behaviour.
 */

export type { FidelityView } from './types';
export { NO_FIDELITY } from './view';

let installed: FidelityService | null = null;

const NO_NATIVE_REPLY = Symbol('fidelity: no native reply');

/**
 * A view of a message whose copy keeps upstream's reply quote. History
 * copies use it: their webhook replaces allowed_mentions with
 * `{ parse: [] }` (src/history/quietWebhook.ts), which leaves Fluxer's
 * `replied_user` on, so a native reply could ping.
 */
export function withoutNativeReply<M extends object>(message: M): M {
    return Object.create(message, {
        [NO_NATIVE_REPLY]: { value: true },
    }) as M;
}

/** Sets or clears the service the transformer hooks use. */
export function installFidelity(service: FidelityService | null): void {
    installed = service;
}

async function viewFor<M extends object>(
    message: M,
    facts: (message: M) => SourceFacts
): Promise<FidelityView> {
    const service = installed;
    if (!service) return NO_FIDELITY;
    let read: SourceFacts;
    try {
        read = facts(message);
    } catch (error) {
        service.warn(error);
        return NO_FIDELITY;
    }
    const quoted = NO_NATIVE_REPLY in message;
    return service.prepare(quoted ? { ...read, reply: null } : read);
}

/** Fidelity for a Discord message copied to Fluxer. */
export function discordFidelity(message: DiscordSource): Promise<FidelityView> {
    return viewFor(message, discordFacts);
}

/** Fidelity for a Fluxer message copied to Discord. */
export function fluxerFidelity(message: FluxerSource): Promise<FidelityView> {
    return viewFor(message, fluxerFacts);
}

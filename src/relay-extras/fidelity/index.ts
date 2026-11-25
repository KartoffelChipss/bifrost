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

/** Sets or clears the service the transformer hooks use. */
export function installFidelity(service: FidelityService | null): void {
    installed = service;
}

async function viewFor<M>(
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
    return service.prepare(read);
}

/** Fidelity for a Discord message copied to Fluxer. */
export function discordFidelity(message: DiscordSource): Promise<FidelityView> {
    return viewFor(message, discordFacts);
}

/** Fidelity for a Fluxer message copied to Discord. */
export function fluxerFidelity(message: FluxerSource): Promise<FidelityView> {
    return viewFor(message, fluxerFacts);
}

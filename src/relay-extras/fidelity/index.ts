import type { FidelityService } from './service';
import {
    discordFacts,
    fluxerFacts,
    type DiscordSource,
    type FluxerSource,
} from './sources';
import type { FidelityView, SourceFacts } from './types';
import { NO_FIDELITY, NO_PINGS, plainView } from './view';

/**
 * The hooks upstream's message transformers call. Upstream builds its
 * transformers in src/discord.ts, src/fluxer.ts and upstreamBridge.ts
 * without a way to pass dependencies, so the service is installed here
 * when the relay extras start and removed when they stop. Without it, or
 * when a lookup fails, every hook returns upstream's formatting with
 * explicit pings (view.ts plainView).
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

/**
 * Fidelity for a Discord message copied to Fluxer. Without it, the copy
 * may still ping everyone when the Discord message did: Discord sets
 * `mention_everyone` only when the author may mention everyone. Like the
 * thread relay (upstreamBridge.toFluxerPayload), nothing else pings.
 */
export async function discordFidelity(
    message: DiscordSource
): Promise<FidelityView> {
    const view = await viewFor(message, discordFacts);
    if (view !== NO_FIDELITY) return view;
    const everyone = message.mentions?.everyone === true;
    return plainView({ ...NO_PINGS, everyone });
}

/**
 * Fidelity for a Fluxer message copied to Discord. Without it, upstream
 * breaks every `@` in the text, and the copy pings no one.
 */
export async function fluxerFidelity(
    message: FluxerSource
): Promise<FidelityView> {
    const view = await viewFor(message, fluxerFacts);
    return view === NO_FIDELITY ? plainView(NO_PINGS) : view;
}

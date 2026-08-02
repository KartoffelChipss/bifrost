import type { Client as FluxerClient } from '@fluxerjs/core';

/**
 * The Fluxer client gets destroyed and recreated on health-check-triggered restarts, so web routes hold a mutable ref rather than a snapshot of the client instance.
 */
export interface FluxerClientRef {
    current: FluxerClient | null;
}

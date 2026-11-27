import { messageRowKey } from '../fluxer-db/keys';
import type { FluxerDb } from '../fluxer-db/pool';
import type { CopyRef } from './store';
import { chunks } from './names';

/** Keys sent per call; bifrost.set_webhook_names refuses more. */
export const NAME_BATCH = 500;

/**
 * Sets webhook_name on Fluxer copies through the bifrost.set_webhook_names
 * function (deploy/fluxer-bridge.sql). The role it connects with can run
 * that function and nothing else.
 */
export class FluxerNameWriter {
    constructor(private readonly db: Pick<FluxerDb, 'rows'>) {}

    /** Checks the function exists and the role may run it. */
    async check(): Promise<void> {
        await this.setBatch([], 'check');
    }

    /** Renames the copies. Returns how many rows changed. */
    async rename(copies: readonly CopyRef[], name: string): Promise<number> {
        const keys = copies.map((c) => messageRowKey(c.channelId, c.messageId));
        let changed = 0;
        for (const batch of chunks(keys, NAME_BATCH)) {
            changed += await this.setBatch(batch, name);
        }
        return changed;
    }

    private async setBatch(keys: readonly string[], name: string) {
        const rows = await this.db.rows<{ changed: unknown }>(
            'SELECT bifrost.set_webhook_names($1::text[], $2) AS changed',
            [keys, name]
        );
        const changed = rows[0]?.changed;
        if (typeof changed !== 'number' || changed < 0) {
            throw new Error('set_webhook_names returned no count');
        }
        return changed;
    }
}

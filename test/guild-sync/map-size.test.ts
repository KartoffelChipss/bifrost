import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_MAP_ROWS, MapTooLargeError } from '../../src/guild-sync/store';
import { discordGuild } from './fixtures';
import { setup } from './harness';

describe('an oversized object map', () => {
    it('stops only this link with an aborted plan, without throwing', async () => {
        const s = setup(discordGuild());
        s.store.loadObjectMap = async () => {
            throw new MapTooLargeError(
                `object map has over ${MAX_MAP_ROWS} rows`
            );
        };
        const outcome = await s.cycle();
        assert.equal(outcome.plan.status, 'aborted');
        assert.match(outcome.plan.abortReason ?? '', /object map has over/);
        assert.equal(s.guild.calls.length, 0);
    });
});

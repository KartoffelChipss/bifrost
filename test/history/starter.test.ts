import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    UpstreamBridge,
    type UpstreamServices,
} from '../../src/guild-sync/upstreamBridge';

const CREATED = new Date('2024-03-01T18:22:00Z');

/** A bridge whose Discord thread starter was written by `authorId`. */
function bridge(authorId: string) {
    const starter = {
        author: { id: authorId },
        createdAt: CREATED,
        createdTimestamp: CREATED.getTime(),
    };
    const thread = {
        isThread: () => true,
        fetchStarterMessage: async () => starter,
    };
    const services = {
        discordClient: { channels: { fetch: async () => thread } },
        linkService: {
            getGuildLinkForDiscordGuild: async () => {
                throw new Error('an opted-out starter is never formatted');
            },
        },
    } as unknown as UpstreamServices;
    return new UpstreamBridge(services);
}

describe('forum post starters', () => {
    it('posts the opt-out placeholder for an opted-out author', async () => {
        const b = bridge('shy');
        b.useOptOuts(async (id) => id === 'shy');
        const payload = await b.starter('g1', 't1');
        assert.equal(payload.username, 'Member');
        assert.deepEqual(payload.content.split('\n'), [
            '*A message from a member who opted out of history import.*',
            '*Originally posted 2024-03-01 18:22 UTC*',
        ]);
    });

    it('formats the starter as usual without an opt-out check', async () => {
        const b = bridge('shy');
        b.useOptOuts(null);
        await assert.rejects(b.starter('g1', 't1'), /never formatted/);
    });
});

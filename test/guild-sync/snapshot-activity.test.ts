import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    compareSnowflakes,
    lastActivityId,
    stableJson,
    withoutActivity,
    type GuildSnapshot,
    type ThreadSnap,
} from '../../src/guild-sync/snapshot';
import { channel, discordGuild } from './fixtures';
import { setup } from './harness';

const thread = (lastMessageId?: string | null): ThreadSnap => ({
    id: '500',
    parentId: '101',
    name: 'post',
    archived: false,
    locked: false,
    tags: [],
    ...(lastMessageId !== undefined ? { lastMessageId } : {}),
});

const guild = (name: string, last: string): GuildSnapshot =>
    discordGuild({
        name,
        channels: [channel('101')],
        threads: [thread(last)],
    });

describe('snowflake order', () => {
    it('orders by age, a shorter snowflake first', () => {
        assert.ok(compareSnowflakes('99', '100') < 0);
        assert.ok(compareSnowflakes('200', '100') > 0);
        assert.equal(compareSnowflakes('42', '42'), 0);
    });

    it("takes a thread's newest message as its activity, else the thread", () => {
        assert.equal(lastActivityId(thread('900')), '900');
        assert.equal(lastActivityId(thread(null)), '500');
        assert.equal(lastActivityId(thread()), '500');
        // A starter message older than the thread is not activity after it.
        assert.equal(lastActivityId(thread('400')), '500');
    });

    it('compares snapshots without thread activity', () => {
        assert.equal(
            stableJson(withoutActivity(guild('s', '600'))),
            stableJson(withoutActivity(guild('s', '700')))
        );
        assert.notEqual(
            stableJson(withoutActivity(guild('s', '600'))),
            stableJson(withoutActivity(guild('t', '600')))
        );
    });
});

describe('saving snapshots with thread activity', () => {
    it('refreshes the last snapshot when only activity changed', async () => {
        const s = setup(guild('s', '600'));
        await s.cycle();
        const saved = () =>
            s.store.snapshots.filter((x) => x.snapshot.side === 'discord');
        assert.equal(saved().length, 1);
        s.discord.result = { ok: true, snapshot: guild('s', '700') };
        await s.cycle();
        assert.equal(saved().length, 1);
        assert.equal(s.store.refreshes, 1);
        assert.equal(saved()[0].snapshot.threads[0].lastMessageId, '700');
        s.discord.result = { ok: true, snapshot: guild('renamed', '700') };
        await s.cycle();
        assert.equal(saved().length, 2);
        assert.equal(s.store.refreshes, 1);
    });
});

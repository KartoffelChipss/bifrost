import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TtlCache } from '../../src/relay-extras/fidelity/cache';
import { accountIds, objectIds } from '../../src/relay-extras/fidelity/maps';
import {
    breakUnpinged,
    channelIdsIn,
    mapEmojis,
    mapMentionToken,
} from '../../src/relay-extras/fidelity/mentions';
import { ACCOUNTS, ROWS } from './fidelity-fakes';

const MAPS = {
    users: new Map([['1', '10']]),
    roles: new Map([['2', '20']]),
    channels: new Map([['3', '30']]),
};

describe('fidelity mention tokens', () => {
    it('maps users, nickname mentions, roles and channels', () => {
        assert.equal(mapMentionToken('<@1>', MAPS), '<@10>');
        assert.equal(mapMentionToken('<@!1>', MAPS), '<@10>');
        assert.equal(mapMentionToken('<@&2>', MAPS), '<@&20>');
        assert.equal(mapMentionToken('<#3>', MAPS), '<#30>');
    });

    it('returns null for an unmapped ID or a malformed token', () => {
        assert.equal(mapMentionToken('<@9>', MAPS), null);
        assert.equal(mapMentionToken('<@&1>', MAPS), null);
        assert.equal(mapMentionToken('<#1>', MAPS), null);
        assert.equal(mapMentionToken('@everyone', MAPS), null);
    });

    it('lists distinct channel mentions up to the limit', () => {
        assert.deepEqual(channelIdsIn('<#1> <#2> <#1> <#3>', 2), ['1', '2']);
        assert.deepEqual(channelIdsIn('no channels', 5), []);
    });
});

describe('fidelity emojis', () => {
    const synced = new Map([['111', '222']]);

    it('swaps a synced emoji for the target one, with its target name', () => {
        const out = mapEmojis('hi <:wave:111>', synced, [
            { id: '222', name: 'hello', animated: true },
        ]);
        assert.equal(out, 'hi <a:hello:222>');
    });

    it('keeps the source name when the target list lacks the emoji', () => {
        assert.equal(mapEmojis('<:wave:111>', synced, []), '<:wave:222>');
    });

    it('leaves unsynced emojis for upstream to match by name', () => {
        assert.equal(mapEmojis('<:other:333>', synced, []), '<:other:333>');
    });
});

describe('fidelity breakMentions', () => {
    it('breaks every @ like upstream, except mention tokens', () => {
        assert.equal(
            breakUnpinged('@bob <@10> <@&20> a@b.c', false),
            '@​bob <@10> <@&20> a@​b.c'
        );
    });

    it('breaks @everyone and @here unless everyone may be pinged', () => {
        assert.equal(
            breakUnpinged('@everyone @here', false),
            '@​everyone @​here'
        );
        assert.equal(breakUnpinged('@everyone @here', true), '@everyone @here');
    });
});

describe('fidelity maps', () => {
    it('keeps active object map pairs, in both directions', () => {
        const ids = objectIds(ROWS);
        assert.equal(ids.discord.roles.get('111'), '211');
        assert.equal(ids.fluxer.roles.get('211'), '111');
        assert.equal(ids.discord.channels.get('122'), '222');
        assert.equal(ids.discord.emojis.get('131'), '231');
        assert.equal(ids.fluxer.stickers.get('241'), '141');
        assert.equal(ids.discord.roles.has('112'), false);
    });

    it('maps linked accounts both ways', () => {
        const ids = accountIds(ACCOUNTS);
        assert.equal(ids.discord.get('101'), '201');
        assert.equal(ids.fluxer.get('201'), '101');
    });
});

describe('TtlCache', () => {
    it('reloads after the TTL and drops the oldest entry when full', async () => {
        let now = 0;
        let loads = 0;
        const cache = new TtlCache<number>(100, 2, () => now);
        const load = async () => ++loads;
        assert.equal(await cache.get('a', load), 1);
        assert.equal(await cache.get('a', load), 1);
        now = 100;
        assert.equal(await cache.get('a', load), 2);
        await cache.get('b', load);
        await cache.get('c', load);
        assert.equal(await cache.get('a', load), 5);
    });

    it('rejects a non-positive TTL or size', () => {
        assert.throws(() => new TtlCache(0, 1, () => 0), RangeError);
        assert.throws(() => new TtlCache(1, 0, () => 0), RangeError);
    });
});

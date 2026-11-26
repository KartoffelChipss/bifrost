import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MapRow } from '../../src/guild-sync/ops';
import {
    EMOJI_MAP_TTL_MS,
    EmojiTranslator,
    MAX_CACHED_LINKS,
} from '../../src/relay-extras/emojiMap';
import type { Side } from '../../src/relay-extras/types';

function row(over: Partial<MapRow>): MapRow {
    return {
        id: 'row',
        kind: 'emoji',
        discordId: null,
        fluxerId: null,
        state: 'active',
        createdBySync: true,
        missingSince: null,
        missingCount: 0,
        destMissingCount: 0,
        destMissingSince: null,
        appliedFields: null,
        ...over,
    };
}

const ROWS: MapRow[] = [
    row({ discordId: 'd1', fluxerId: 'f1' }),
    row({ discordId: 'd2', fluxerId: 'f2', state: 'archived' }),
    row({ kind: 'role', discordId: 'd3', fluxerId: 'f3' }),
];

function setup() {
    const state = { now: 0, loads: [] as string[] };
    const translator = new EmojiTranslator({
        async loadObjectMap(id) {
            state.loads.push(id);
            return ROWS;
        },
        async guildEmoji(side: Side, _link, id) {
            if (id === 'gone') return null;
            return { id, name: `${side}-name`, animated: side === 'fluxer' };
        },
        now: () => state.now,
    });
    return { state, translator };
}

const custom = (id: string) => ({ id, name: 'x', animated: false });

describe('EmojiTranslator', () => {
    it('passes a unicode emoji through without reading the map', async () => {
        const { state, translator } = setup();
        const thumbs = { id: null, name: '👍', animated: false };
        assert.equal(
            await translator.translate('discord', 'l', thumbs),
            thumbs
        );
        assert.equal(
            await translator.translate('discord', 'l', { ...thumbs, name: '' }),
            null
        );
        assert.deepEqual(state.loads, []);
    });

    it('maps a custom emoji both ways with the destination name', async () => {
        const { translator } = setup();
        assert.deepEqual(
            await translator.translate('discord', 'l', custom('d1')),
            {
                id: 'f1',
                name: 'fluxer-name',
                animated: true,
            }
        );
        assert.deepEqual(
            await translator.translate('fluxer', 'l', custom('f1')),
            {
                id: 'd1',
                name: 'discord-name',
                animated: false,
            }
        );
    });

    it('skips unmapped, archived and non-emoji rows', async () => {
        const { translator } = setup();
        for (const id of ['d9', 'd2', 'd3']) {
            assert.equal(
                await translator.translate('discord', 'l', custom(id)),
                null
            );
        }
    });

    it('skips an emoji gone from the destination server', async () => {
        const translator = new EmojiTranslator({
            loadObjectMap: async () => [
                row({ discordId: 'd1', fluxerId: 'gone' }),
            ],
            guildEmoji: async () => null,
            now: () => 0,
        });
        assert.equal(
            await translator.translate('discord', 'l', custom('d1')),
            null
        );
    });

    it('caches the map per link for a few minutes', async () => {
        const { state, translator } = setup();
        await translator.translate('discord', 'a', custom('d1'));
        await translator.translate('discord', 'a', custom('d1'));
        await translator.translate('discord', 'b', custom('d1'));
        state.now = EMOJI_MAP_TTL_MS;
        await translator.translate('discord', 'a', custom('d1'));
        assert.deepEqual(state.loads, ['a', 'b', 'a']);
    });

    it('keeps at most MAX_CACHED_LINKS links, dropping the oldest', async () => {
        const { state, translator } = setup();
        for (let i = 0; i <= MAX_CACHED_LINKS; i++) {
            await translator.translate('discord', `l${i}`, custom('d1'));
        }
        await translator.translate(
            'discord',
            `l${MAX_CACHED_LINKS}`,
            custom('d1')
        );
        await translator.translate('discord', 'l0', custom('d1'));
        assert.equal(state.loads.length, MAX_CACHED_LINKS + 2);
        assert.equal(state.loads[state.loads.length - 1], 'l0');
    });
});

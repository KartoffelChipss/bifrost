import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client as DiscordClient } from 'discord.js';
import {
    CATEGORY_WARN_INTERVAL_MS,
    discordCategory,
} from '../../src/guild-sync/index';
import { excludedLinks, type LinkedChannel } from '../../src/guild-sync/links';
import { createRecordingLogger } from '../addons/fakes';

const link = (discordChannelId: string): LinkedChannel => ({
    id: `cl-${discordChannelId}`,
    guildLinkId: 'gl',
    discordChannelId,
    fluxerChannelId: `f-${discordChannelId}`,
    discordWebhook: { id: 'dw', token: 'dw-token' },
    fluxerWebhook: { id: 'fw', token: 'fw-token' },
});

/** A Discord client whose channel fetch fails, as for a deleted channel. */
function unreachable(): Pick<DiscordClient, 'channels'> {
    return {
        channels: {
            cache: new Map(),
            fetch: async () => {
                throw new Error('Unknown Channel');
            },
        },
    } as unknown as Pick<DiscordClient, 'channels'>;
}

function setup() {
    const logger = createRecordingLogger();
    const clock = { ms: 0 };
    const categoryOf = discordCategory(
        unreachable(),
        logger,
        () => new Date(clock.ms)
    );
    const excluded = excludedLinks(new Set(['d-category']), categoryOf);
    const warnings = () => logger.entries.filter((e) => e.level === 'warn');
    return { excluded, clock, warnings };
}

describe('a linked Discord channel that cannot be fetched', () => {
    it('counts as not excluded instead of failing', async () => {
        const s = setup();
        assert.equal(await s.excluded(link('d-gone')), false);
    });

    it('is logged once per channel per interval', async () => {
        const s = setup();
        for (let i = 0; i < 3; i++) await s.excluded(link('d-gone'));
        await s.excluded(link('d-other'));
        assert.equal(s.warnings().length, 2);
        assert.match(s.warnings()[0]?.message ?? '', /d-gone.*Unknown Channel/);
        s.clock.ms = CATEGORY_WARN_INTERVAL_MS;
        await s.excluded(link('d-gone'));
        assert.equal(s.warnings().length, 3);
    });

    it('is still excluded when the channel itself is listed', async () => {
        const logger = createRecordingLogger();
        const excluded = excludedLinks(
            new Set(['d-gone']),
            discordCategory(unreachable(), logger)
        );
        assert.equal(await excluded(link('d-gone')), true);
    });
});

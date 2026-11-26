import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { archivePass, type ArchiveParts } from '../../src/archive';
import type { ChannelProgress } from '../../src/archive/types';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import { createRecordingLogger } from '../addons/fakes';
import { progress } from './fakes';

const LINK = { id: 'link-1', discordGuildId: '100', fluxerGuildId: 'f1' };

function snapshot(): GuildSnapshot {
    return {
        guildId: '100',
        channels: [{ id: '200', type: 0, parentId: null }],
        threads: [],
    } as unknown as GuildSnapshot;
}

function parts(fields: {
    snapshot?: GuildSnapshot | null;
    channels?: ChannelProgress[];
    more?: boolean;
    failSnapshot?: boolean;
}) {
    const walked: string[] = [];
    const upkeep: string[] = [];
    const logger = createRecordingLogger();
    const p: ArchiveParts = {
        store: {
            ensureChannels: async () => {},
            channels: async () => fields.channels ?? [],
            totals: async () => {
                throw new Error('not used');
            },
        },
        snapshot: async () => {
            if (fields.failSnapshot) throw new Error('db down');
            return fields.snapshot === undefined ? snapshot() : fields.snapshot;
        },
        walker: {
            walk: async (channel: ChannelProgress) => {
                walked.push(channel.channelId);
                return { messages: 1, files: 0, more: fields.more ?? false };
            },
        },
        upkeep: {
            redactOptedOut: async () => {
                upkeep.push('redact');
                return 0;
            },
            retryFiles: async () => {
                upkeep.push('retry');
            },
        },
        logger,
    };
    return { p, walked, upkeep, logger };
}

const deps = {
    excludedChannels: new Set<string>(),
    listGuildLinks: async () => [LINK],
};
const held = async () => true;

describe('archivePass', () => {
    it('walks due channels, then runs upkeep', async () => {
        const { p, walked, upkeep } = parts({ channels: [progress()] });
        assert.equal(await archivePass(p, deps, held), false);
        assert.deepEqual(walked, ['200']);
        assert.deepEqual(upkeep, ['redact', 'retry']);
    });

    it('reports work left when a walk stops for time', async () => {
        const { p } = parts({ channels: [progress()], more: true });
        assert.equal(await archivePass(p, deps, held), true);
    });

    it('skips a link without a snapshot, and logs one that fails', async () => {
        const none = parts({ snapshot: null, channels: [progress()] });
        assert.equal(await archivePass(none.p, deps, held), false);
        assert.deepEqual(none.walked, []);
        const failing = parts({ failSnapshot: true });
        assert.equal(await archivePass(failing.p, deps, held), false);
        assert.match(failing.logger.entries[0]?.message ?? '', /db down/);
        assert.deepEqual(failing.upkeep, ['redact', 'retry']);
    });

    it('starts no walk once the lock is lost', async () => {
        const { p, walked } = parts({ channels: [progress()] });
        assert.equal(await archivePass(p, deps, async () => false), true);
        assert.deepEqual(walked, []);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    CycleBackoff,
    FIRST_CYCLE_BACKOFF_MS,
    OwnershipLostError,
    guardCycle,
} from '../../src/guild-sync/cycleGuard';
import { runAll, type GuildSyncDeps } from '../../src/guild-sync/index';
import type { GuildSyncStore } from '../../src/guild-sync/store';
import { createRecordingLogger } from '../addons/fakes';
import { D_GUILD, F_GUILD, discordGuild } from './fixtures';
import { setup } from './harness';

describe('cycle errors', () => {
    it('logs and backs off a plain error, then tries again', async () => {
        let now = 0;
        const deps = {
            backoff: new CycleBackoff(),
            now: () => new Date(now),
            logger: createRecordingLogger(),
        };
        const boom = async () => {
            throw new Error('connection reset');
        };
        assert.deepEqual(await guardCycle('run', deps, boom), {
            ok: false,
            reason: 'failed',
        });
        assert.deepEqual(await guardCycle('run', deps, async () => 1), {
            ok: false,
            reason: 'backoff',
        });
        now += FIRST_CYCLE_BACKOFF_MS;
        assert.deepEqual(await guardCycle('run', deps, async () => 1), {
            ok: true,
            value: 1,
        });
    });

    it('rethrows a lost ownership record for the isolation boundary', async () => {
        const deps = {
            backoff: new CycleBackoff(),
            now: () => new Date(0),
            logger: createRecordingLogger(),
        };
        await assert.rejects(
            guardCycle('run', deps, async () => {
                throw new OwnershipLostError('lost', null);
            }),
            OwnershipLostError
        );
    });

    it('raises OwnershipLostError when a written create cannot be recorded', async () => {
        const s = setup(discordGuild());
        const audit = s.store.audit.bind(s.store);
        // The intent before the write is saved; the record after it fails.
        s.store.audit = async (entry, now) => {
            if (entry.result === 'ok') throw new Error('database gone');
            return audit(entry, now);
        };
        await assert.rejects(s.cycle(), OwnershipLostError);
    });

    it('keeps other links running when one link fails', async () => {
        const s = setup(discordGuild());
        const store: GuildSyncStore = s.store;
        const load = store.loadSettings.bind(store);
        store.loadSettings = async (id: string) => {
            if (id === 'bad') throw new Error('settings unreadable');
            return load(id);
        };
        const links = [
            { id: 'bad', discordGuildId: D_GUILD, fluxerGuildId: F_GUILD },
            { id: 'good', discordGuildId: D_GUILD, fluxerGuildId: F_GUILD },
        ];
        const deps = {
            listGuildLinks: async () => links,
        } as unknown as GuildSyncDeps;
        const pruned: string[] = [];
        s.store.prunePlans = async () => {
            pruned.push('plans');
            return 0;
        };
        await runAll(s.store, deps, s.depsFor(), 'me', new CycleBackoff());
        assert.deepEqual(pruned, ['plans']);
        assert.ok(s.store.plans.some((p) => p.guildLinkId === 'good'));
        assert.ok(!s.store.plans.some((p) => p.guildLinkId === 'bad'));
    });
});

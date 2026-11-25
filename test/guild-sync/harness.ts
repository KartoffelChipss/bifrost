import assert from 'node:assert/strict';
import type { AddonMode } from '../../src/addons/config';
import { runCycle, type CycleDeps } from '../../src/guild-sync/cycle';
import type { Plan } from '../../src/guild-sync/plan';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import { createRecordingLogger } from '../addons/fakes';
import { FakeGuild } from './fake-guild';
import {
    DEFAULT_SETTINGS,
    FakeAssets,
    FakeLinker,
    FakeReader,
    FakeStore,
    FakeThreadSource,
    recordingNotices,
} from './fake-store';
import { D_GUILD, F_GUILD, fluxerGuild } from './fixtures';

/** A full cycle harness: Discord as a fixed reader, Fluxer as a FakeGuild. */

export const LINK = {
    id: 'link-1',
    discordGuildId: D_GUILD,
    fluxerGuildId: F_GUILD,
};
export const NOW = new Date('2026-11-25T12:00:00Z');

export const opCount = (plan: Plan) =>
    plan.body.ops.length + plan.body.deferred.length;

export function setup(source: GuildSnapshot, mode: AddonMode = 'dry-run') {
    const store = new FakeStore();
    store.settings = { ...DEFAULT_SETTINGS, mode: 'apply' };
    const guild = new FakeGuild(fluxerGuild());
    const discord = new FakeReader({ ok: true, snapshot: source });
    const assets = new FakeAssets();
    const linker = new FakeLinker();
    const wiring = {
        links: null as FakeLinker | null,
        ready: undefined as ReadonlySet<string> | undefined,
        excluded: new Set<string>() as ReadonlySet<string>,
    };
    const notices = recordingNotices();
    const pauses: number[] = [];
    let seq = 0;
    const state = { processMode: mode, allowApply: true, now: NOW };
    const deps = (): CycleDeps => ({
        store,
        readers: { discord, fluxer: guild },
        writers: { fluxer: guild },
        assets: { discord: assets },
        links: wiring.links,
        excludedChannels: wiring.excluded,
        historyReady: wiring.ready
            ? async () => wiring.ready ?? new Set<string>()
            : undefined,
        threadSources: { discord: new FakeThreadSource() },
        notices: notices.board,
        commandPrefix: '!b ',
        processMode: () => state.processMode,
        allowApply: state.allowApply,
        pause: async (ms) => {
            pauses.push(ms);
        },
        logger: createRecordingLogger(),
        now: () => state.now,
        newId: () =>
            `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    });
    const cycle = async () => {
        const outcome = await runCycle(LINK, deps());
        assert.equal(outcome.status, 'planned');
        return outcome as Extract<typeof outcome, { status: 'planned' }>;
    };
    /** Moves the clock forward. */
    const wait = (minutes: number) => {
        state.now = new Date(state.now.getTime() + minutes * 60_000);
    };
    return {
        store,
        guild,
        discord,
        assets,
        linker,
        /** Turns on channel linking, as the running bot has it. */
        useLinks: () => {
            wiring.links = linker;
        },
        /** Sets BF_ADDONS_EXCLUDE_CHANNELS. */
        exclude: (ids: string[]) => {
            wiring.excluded = new Set(ids);
        },
        /** Turns on history gating with this set of copied channels. */
        historyReady: (ready: ReadonlySet<string>) => {
            wiring.ready = ready;
        },
        posted: notices.posted,
        pauses,
        state,
        cycle,
        wait,
        /** The cycle deps, for a test that overrides one of them. */
        depsFor: deps,
    };
}

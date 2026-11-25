import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AddonMode } from '../../src/addons/config';
import type { LinkedGuild } from '../../src/guild-sync/cycle';
import type { MemberState } from '../../src/identity/ports';
import {
    MAX_ROLE_REMOVALS_PER_HOUR,
    PLAN_TTL_MS,
    RoleSync,
    rotate,
} from '../../src/identity/roleSync';
import type { AccountPair } from '../../src/identity/store';
import { createRecordingLogger } from '../addons/fakes';
import { DEFAULT_SETTINGS, FakeStore } from '../guild-sync/fake-store';
import { D_GUILD, discordGuild, mapRow, role } from '../guild-sync/fixtures';

const LINK: LinkedGuild = {
    id: 'link-1',
    discordGuildId: '100',
    fluxerGuildId: '900',
};
const HOUR_MS = 60 * 60_000;

class CountingStore extends FakeStore {
    settingsLoads = 0;
    snapshotLoads = 0;
    override async loadSettings() {
        this.settingsLoads += 1;
        return super.loadSettings();
    }
    override async lastSnapshot(
        ...args: Parameters<FakeStore['lastSnapshot']>
    ) {
        this.snapshotLoads += 1;
        return super.lastSnapshot(...args);
    }
}

class FakeMembers {
    discord = new Map<string, MemberState>();
    fluxer = new Map<string, MemberState>();
    failFor = new Set<string>();
    roleWrites: string[] = [];
    nickWrites: string[] = [];

    async discordMember(_guild: string, userId: string) {
        if (this.failFor.has(userId)) throw new Error('Discord is down');
        return this.discord.get(userId) ?? null;
    }
    async fluxerMember(_guild: string, userId: string) {
        return this.fluxer.get(userId) ?? null;
    }
    async setFluxerMemberRoles(_guild: string, userId: string, ids: string[]) {
        this.roleWrites.push(`${userId}:${ids.join(',')}`);
        const old = this.fluxer.get(userId);
        this.fluxer.set(userId, { roleIds: ids, nick: old?.nick ?? null });
    }
    async setFluxerMemberNick(
        _guild: string,
        userId: string,
        nick: string | null
    ) {
        this.nickWrites.push(`${userId}:${nick}`);
        const old = this.fluxer.get(userId);
        this.fluxer.set(userId, { roleIds: old?.roleIds ?? [], nick });
    }
}

function setup(mode: 'dry-run' | 'apply' = 'apply') {
    const store = new CountingStore();
    store.settings = { ...DEFAULT_SETTINGS, mode };
    store.snapshots.push({
        snapshot: discordGuild({
            roles: [role(D_GUILD), role('gamer')],
        }),
        healthy: true,
    });
    store.rows = [mapRow('role', 'gamer', 'f-gamer')];
    const members = new FakeMembers();
    const logger = createRecordingLogger();
    const clock = { now: 1_000_000 };
    const processMode: AddonMode = 'dry-run';
    const roles = new RoleSync({
        store,
        ports: members,
        listGuildLinks: async () => [LINK],
        processMode: () => processMode,
        allowApply: true,
        logger,
        now: () => clock.now,
    });
    return { store, members, logger, clock, roles };
}

const pairOf = (n: number): AccountPair => ({
    discordUserId: `d${n}`,
    fluxerUserId: `f${n}`,
});

/** Linked members who lost the synced role on Discord. */
function withStaleRoles(s: ReturnType<typeof setup>, count: number) {
    const pairs: AccountPair[] = [];
    for (let n = 0; n < count; n++) {
        pairs.push(pairOf(n));
        s.members.discord.set(`d${n}`, { roleIds: [], nick: null });
        s.members.fluxer.set(`f${n}`, { roleIds: ['f-gamer'], nick: null });
    }
    return pairs;
}

describe('RoleSync sweep', () => {
    it('keeps going after one member fails, and loads the link once', async () => {
        const s = setup();
        const pairs = [pairOf(1), pairOf(2), pairOf(3)];
        for (const pair of pairs) {
            s.members.discord.set(pair.discordUserId, {
                roleIds: ['gamer'],
                nick: null,
            });
            s.members.fluxer.set(pair.fluxerUserId, {
                roleIds: [],
                nick: null,
            });
        }
        s.members.failFor.add('d2');
        const result = await s.roles.sweepLink(LINK, pairs);
        assert.deepEqual(s.members.roleWrites, ['f1:f-gamer', 'f3:f-gamer']);
        assert.equal(result?.tally.add, 2);
        assert.equal(s.store.settingsLoads, 1);
        const warnings = s.logger.entries.filter((e) => e.level === 'warn');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].message, /d2/);
    });

    it('caps role removals per hour across sweeps and member events', async () => {
        const s = setup();
        const pairs = withStaleRoles(s, MAX_ROLE_REMOVALS_PER_HOUR + 10);
        const first = await s.roles.sweepLink(LINK, pairs);
        assert.equal(first?.tally.remove, MAX_ROLE_REMOVALS_PER_HOUR);
        const second = await s.roles.sweepLink(LINK, pairs);
        assert.equal(second?.tally.remove, 0);
        await s.roles.pair(pairs[pairs.length - 1]);
        assert.equal(s.members.roleWrites.length, MAX_ROLE_REMOVALS_PER_HOUR);
        s.clock.now += HOUR_MS + 1;
        const later = await s.roles.sweepLink(LINK, pairs);
        assert.equal(later?.tally.remove, 10);
    });

    it('only counts in dry-run and spends no removal budget', async () => {
        const s = setup('dry-run');
        const pairs = withStaleRoles(s, MAX_ROLE_REMOVALS_PER_HOUR + 5);
        s.members.discord.set('d0', { roleIds: [], nick: 'Ada' });
        const dry = await s.roles.sweepLink(LINK, pairs);
        assert.equal(dry?.plan.mode, 'dry-run');
        assert.equal(dry?.tally.remove, MAX_ROLE_REMOVALS_PER_HOUR + 5);
        assert.equal(dry?.tally.nicks, 1);
        assert.deepEqual(s.members.roleWrites, []);
        assert.deepEqual(s.members.nickWrites, []);
        s.store.settings = { ...DEFAULT_SETTINGS, mode: 'apply' };
        const applied = await s.roles.sweepLink(LINK, pairs);
        assert.equal(applied?.tally.remove, MAX_ROLE_REMOVALS_PER_HOUR);
    });

    it('syncs nothing on a read-only link', async () => {
        const s = setup();
        s.store.settings = { ...DEFAULT_SETTINGS, killSwitch: true };
        assert.equal(await s.roles.sweepLink(LINK, withStaleRoles(s, 1)), null);
    });
});

describe('RoleSync nicknames', () => {
    it('copies the Discord nickname and clears only one it wrote', async () => {
        const s = setup();
        const pair = pairOf(1);
        s.members.discord.set('d1', { roleIds: [], nick: 'Ada' });
        s.members.fluxer.set('f1', { roleIds: [], nick: null });
        await s.roles.pair(pair);
        assert.deepEqual(s.members.nickWrites, ['f1:Ada']);
        await s.roles.pair(pair);
        assert.equal(s.members.nickWrites.length, 1);
        s.members.discord.set('d1', { roleIds: [], nick: null });
        await s.roles.pair(pair);
        assert.deepEqual(s.members.nickWrites, ['f1:Ada', 'f1:null']);
    });

    it('leaves a nickname the member chose on Fluxer', async () => {
        const s = setup();
        s.members.discord.set('d1', { roleIds: [], nick: null });
        s.members.fluxer.set('f1', { roleIds: [], nick: 'Own pick' });
        await s.roles.pair(pairOf(1));
        assert.deepEqual(s.members.nickWrites, []);
    });

    it('never throws from a member event', async () => {
        const s = setup();
        s.members.failFor.add('d1');
        await s.roles.pair(pairOf(1));
        const failing = new RoleSync({
            store: s.store,
            ports: s.members,
            listGuildLinks: async () => {
                throw new Error('database is down');
            },
            processMode: () => 'dry-run',
            allowApply: true,
            logger: s.logger,
            now: () => 0,
        });
        await failing.pair(pairOf(1));
        assert.equal(
            s.logger.entries.filter((e) => e.level === 'warn').length,
            2
        );
    });
});

describe('RoleSync members who left and unlinks', () => {
    it('treats a member gone from Discord as holding no roles, within the limit', async () => {
        const s = setup();
        const pairs: AccountPair[] = [];
        for (let n = 0; n < MAX_ROLE_REMOVALS_PER_HOUR + 3; n++) {
            pairs.push(pairOf(n));
            s.members.fluxer.set(`f${n}`, {
                roleIds: ['f-gamer', 'own'],
                nick: null,
            });
        }
        const result = await s.roles.sweepLink(LINK, pairs);
        assert.equal(result?.tally.remove, MAX_ROLE_REMOVALS_PER_HOUR);
        assert.equal(s.members.roleWrites[0], 'f0:own');
    });

    it('strips synced roles on unlink in apply, and nothing in dry-run', async () => {
        const s = setup();
        s.members.discord.set('d1', { roleIds: ['gamer'], nick: null });
        s.members.fluxer.set('f1', { roleIds: ['f-gamer', 'own'], nick: null });
        await s.roles.strip(pairOf(1));
        assert.deepEqual(s.members.roleWrites, ['f1:own']);

        const t = setup('dry-run');
        t.members.fluxer.set('f1', { roleIds: ['f-gamer'], nick: null });
        await t.roles.strip(pairOf(1));
        assert.deepEqual(t.members.roleWrites, []);
    });
});

describe('RoleSync bounds', () => {
    it('stops a sweep at its deadline and reports how many it checked', async () => {
        const s = setup();
        const pairs = withStaleRoles(s, 5);
        s.members.fluxerMember = async (_guild, userId) => {
            s.clock.now += 10;
            return { roleIds: ['f-gamer'], nick: null, userId };
        };
        const result = await s.roles.sweepLink(LINK, pairs, s.clock.now + 25);
        assert.equal(result?.checked, 3);
    });

    it('resumes in rotated order', () => {
        assert.deepEqual(rotate([1, 2, 3, 4], 3), [4, 1, 2, 3]);
        assert.deepEqual(rotate([1, 2], 5), [2, 1]);
        assert.deepEqual(rotate([], 2), []);
    });

    it('reuses a link role lists for member events until they expire', async () => {
        const s = setup();
        s.members.discord.set('d1', { roleIds: ['gamer'], nick: null });
        s.members.fluxer.set('f1', { roleIds: [], nick: null });
        await s.roles.pair(pairOf(1));
        await s.roles.pair(pairOf(1));
        assert.equal(s.store.snapshotLoads, 1);
        s.clock.now += PLAN_TTL_MS;
        await s.roles.pair(pairOf(1));
        assert.equal(s.store.snapshotLoads, 2);
        await s.roles.sweepLink(LINK, [pairOf(1)]);
        assert.equal(s.store.snapshotLoads, 3);
    });
});

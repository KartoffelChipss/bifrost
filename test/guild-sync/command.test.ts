import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    describeStatus,
    parseSyncCommand,
    runSyncCommand,
    type SyncCommand,
} from '../../src/guild-sync/command';
import { EMPTY_BODY, type Plan } from '../../src/guild-sync/plan';
import { DEFAULT_SETTINGS, FakeStore } from './fake-store';

describe('parseSyncCommand', () => {
    it('reads history retry', () => {
        assert.deepEqual(parseSyncCommand(['history', 'retry']), {
            type: 'history-retry',
        });
        assert.equal(parseSyncCommand(['history']).type, 'error');
    });

    it('reads status, mode and kill', () => {
        assert.deepEqual(parseSyncCommand([]), { type: 'status' });
        assert.deepEqual(parseSyncCommand(['status']), { type: 'status' });
        assert.deepEqual(parseSyncCommand(['mode', 'APPLY']), {
            type: 'mode',
            mode: 'apply',
        });
        assert.deepEqual(parseSyncCommand(['kill', 'on']), {
            type: 'kill',
            on: true,
        });
        assert.deepEqual(parseSyncCommand(['channel', 'here']), {
            type: 'channel',
            here: true,
        });
        const planId = '00000000-0000-4000-8000-000000000001';
        assert.deepEqual(parseSyncCommand(['approve', planId]), {
            type: 'approve',
            planId,
        });
        assert.deepEqual(parseSyncCommand(['reject', planId]), {
            type: 'reject',
            planId,
        });
    });

    it('rejects anything else instead of guessing', () => {
        const bad = [
            ['mode'],
            ['mode', 'yolo'],
            ['mode', 'apply', 'now'],
            ['kill', 'maybe'],
            ['channel', 'there'],
            ['approve'],
            ['approve', 'not-a-plan-id'],
            ['status', 'extra'],
            ['delete-everything'],
        ];
        for (const args of bad) {
            assert.equal(parseSyncCommand(args).type, 'error', args.join(' '));
        }
    });
});

describe('describeStatus', () => {
    const plan: Plan = {
        id: 'plan-1',
        guildLinkId: 'link-1',
        direction: 'discord-to-fluxer',
        status: 'dry-run',
        body: EMPTY_BODY,
        abortReason: null,
    };

    it('says so when apply is set but the environment forbids it', () => {
        const settings = { ...DEFAULT_SETTINGS, mode: 'apply' as const };
        assert.match(
            describeStatus(settings, false, plan),
            /BF_ADDONS_ALLOW_APPLY/
        );
        assert.doesNotMatch(
            describeStatus(settings, true, plan),
            /BF_ADDONS_ALLOW_APPLY/
        );
    });

    it('shows the kill switch and the last plan', () => {
        const text = describeStatus(
            { ...DEFAULT_SETTINGS, killSwitch: true },
            true,
            plan
        );
        assert.match(text, /Kill switch: \*\*on\*\*/);
        assert.match(text, /Plan plan-1/);
        assert.match(describeStatus(DEFAULT_SETTINGS, true, null), /No plan/);
    });
});

describe('runSyncCommand', () => {
    const LINK = { id: 'link-1', discordGuildId: 'd', fluxerGuildId: 'f' };
    const PLAN_ID = '00000000-0000-4000-8000-000000000001';
    type Runnable = Exclude<SyncCommand, { type: 'error' }>;

    function setup(
        linked: string[] = [],
        retryHistory?: (linkId: string, now: Date) => Promise<number>
    ) {
        const store = new FakeStore();
        const result = (command: Runnable, channelId = 'admin') =>
            runSyncCommand(command, LINK, channelId, {
                store,
                isChannelLinked: async (id) => linked.includes(id),
                retryHistory,
                now: () => new Date(),
            });
        // The error text, or null when the command worked.
        const run = async (command: Runnable, channelId = 'admin') => {
            const outcome = await result(command, channelId);
            return typeof outcome === 'string' ? outcome : null;
        };
        return { store, run, result };
    }

    const pending: Plan = {
        id: PLAN_ID,
        guildLinkId: LINK.id,
        direction: 'discord-to-fluxer',
        status: 'pending-approval',
        body: { ...EMPTY_BODY, needsApproval: true, approvalReason: 'budget' },
        abortReason: null,
    };

    it('refuses apply until an admin channel is set', async () => {
        const { store, run } = setup();
        assert.match(
            (await run({ type: 'mode', mode: 'apply' })) ?? '',
            /admin channel first/
        );
        assert.equal(store.settings.mode, 'dry-run');
        assert.equal(await run({ type: 'channel', here: true }), null);
        assert.equal(await run({ type: 'mode', mode: 'apply' }), null);
        assert.equal(store.settings.mode, 'apply');
    });

    it('accepts commands only in the admin channel once it is set', async () => {
        const { store, run } = setup();
        await run({ type: 'channel', here: true });
        assert.match(
            (await run({ type: 'kill', on: true }, 'general')) ?? '',
            /admin channel/
        );
        assert.equal(store.settings.killSwitch, false);
        assert.equal(await run({ type: 'kill', on: true }), null);
        assert.equal(store.settings.killSwitch, true);
    });

    it('refuses a bridged channel as the admin channel', async () => {
        const { store, run } = setup(['bridged']);
        assert.match(
            (await run({ type: 'channel', here: true }, 'bridged')) ?? '',
            /bridged/
        );
        assert.equal(store.settings.adminChannelId, null);
    });

    it('approves or rejects only a plan that waits on this link', async () => {
        const { store, run } = setup();
        const approve: Runnable = { type: 'approve', planId: PLAN_ID };
        assert.match((await run(approve)) ?? '', /No plan/);
        store.plans = [{ ...pending, guildLinkId: 'other-link' }];
        assert.match((await run(approve)) ?? '', /No plan/);
        store.plans = [pending];
        assert.equal(await run(approve), null);
        assert.equal(store.settings.approvedPlanId, PLAN_ID);

        assert.equal(await run({ type: 'reject', planId: PLAN_ID }), null);
        assert.equal(store.plans[0].status, 'aborted');
        assert.equal(store.settings.approvedPlanId, null);
        assert.match((await run(approve)) ?? '', /No plan/);
    });

    it('restarts failed history imports and says how many', async () => {
        const retried: string[] = [];
        const { result } = setup([], async (linkId) => {
            retried.push(linkId);
            return 2;
        });
        assert.deepEqual(await result({ type: 'history-retry' }), {
            note: 'Restarted 2 failed history imports.',
        });
        assert.deepEqual(retried, [LINK.id]);
    });

    it('says so when history import is off', async () => {
        const { run } = setup();
        assert.match(
            (await run({ type: 'history-retry' })) ?? '',
            /not switched on/
        );
    });
});

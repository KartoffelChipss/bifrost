import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FlowDeps } from '../../src/identity/flow';
import { FAILED_REPLY, answer, dryRunNotice } from '../../src/identity/index';
import type { IdentityStore } from '../../src/identity/store';
import { createRecordingLogger } from '../addons/fakes';

/** A store with one account already linked, so `unlink` sends two DMs. */
function linkedStore(): IdentityStore {
    const pair = { discordUserId: 'd1', fluxerUserId: 'f1' };
    const unused = () => Promise.reject(new Error('not used'));
    return {
        pairFor: async () => pair,
        deletePair: async () => pair,
        savePair: unused,
        listPairs: unused,
        saveCode: unused,
        takeCode: unused,
        savePending: unused,
        takePending: unused,
        recordFailure: unused,
        failuresSince: unused,
        purgeExpired: unused,
    };
}

function flow(): FlowDeps {
    return {
        store: linkedStore(),
        nameOf: async () => 'name',
        history: null,
        onLinked: async () => {},
        now: () => new Date(0),
        logger: createRecordingLogger(),
    };
}

describe('answer', () => {
    it('logs a DM that cannot be sent and still sends the rest', async () => {
        const logger = createRecordingLogger();
        const sent: string[] = [];
        const ports = {
            sendDm: async (side: string, userId: string) => {
                if (side === 'discord') throw new Error('Cannot send to user');
                sent.push(`${side}:${userId}`);
            },
        };
        await answer(
            { side: 'discord', userId: 'd1', text: 'unlink' },
            flow(),
            ports,
            logger
        );
        assert.deepEqual(sent, ['fluxer:f1']);
        const warnings = logger.entries.filter((e) => e.level === 'warn');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].message, /discord user d1/);
    });
});

describe('answer on a failure', () => {
    it('apologises and logs instead of throwing when handling fails', async () => {
        const logger = createRecordingLogger();
        const sent: string[] = [];
        const broken: FlowDeps = {
            ...flow(),
            store: {
                ...linkedStore(),
                deletePair: () => Promise.reject(new Error('db down')),
            },
        };
        await answer(
            { side: 'fluxer', userId: 'f1', text: 'unlink' },
            broken,
            {
                sendDm: async (side, userId, text) => {
                    sent.push(`${side}:${userId}:${text}`);
                },
            },
            logger
        );
        assert.deepEqual(sent, [`fluxer:f1:${FAILED_REPLY}`]);
        assert.equal(logger.entries.length, 1);
    });
});

describe('dryRunNotice', () => {
    it('counts roles and nicknames', () => {
        const text = dryRunNotice(3, { add: 1, remove: 2, nicks: 4 });
        assert.match(text, /3 linked members/);
        assert.match(text, /add 1 roles, remove 2 roles and set 4 nicknames/);
    });
});

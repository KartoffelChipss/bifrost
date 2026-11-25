import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DmGate, MAX_DMS_PER_MINUTE } from '../../src/identity/gate';
import { RollingLimit } from '../../src/identity/limits';
import { NickMemory, nickChange } from '../../src/identity/nick';

describe('RollingLimit', () => {
    it('grants up to the limit and frees slots as the window rolls', () => {
        const limit = new RollingLimit(3, 1_000, 10);
        assert.equal(limit.take('a', 2, 0), 2);
        assert.equal(limit.take('a', 2, 500), 1);
        assert.equal(limit.remaining('a', 500), 0);
        assert.equal(limit.take('b', 1, 500), 1);
        assert.equal(limit.remaining('a', 1_001), 2);
        assert.equal(limit.remaining('a', 1_501), 3);
    });

    it('rejects bad arguments', () => {
        assert.throws(() => new RollingLimit(0, 1, 1), RangeError);
        assert.throws(() => new RollingLimit(1, 0, 1), RangeError);
        assert.throws(() => new RollingLimit(1, 1, 1).take('a', -1, 0));
    });

    it('drops the oldest key beyond the key limit', () => {
        const limit = new RollingLimit(1, 1_000, 2);
        limit.take('a', 1, 0);
        limit.take('b', 1, 0);
        limit.take('c', 1, 0);
        assert.equal(limit.remaining('a', 0), 1);
        assert.equal(limit.remaining('c', 0), 0);
    });
});

describe('DmGate', () => {
    it('ignores DMs that start with the command prefix', () => {
        const gate = new DmGate('!b ');
        assert.equal(gate.admit('discord', 'u1', '!b help', 0), false);
        assert.equal(gate.admit('fluxer', 'u1', '!b link 123', 0), false);
        assert.equal(gate.admit('discord', 'u1', 'link', 0), true);
    });

    it('answers at most a fixed number of DMs per user per minute', () => {
        const gate = new DmGate('!b ');
        for (let i = 0; i < MAX_DMS_PER_MINUTE; i++)
            assert.equal(gate.admit('discord', 'u1', 'hi', i), true);
        assert.equal(gate.admit('discord', 'u1', 'hi', 100), false);
        assert.equal(gate.admit('fluxer', 'u1', 'hi', 100), true);
        assert.equal(gate.admit('discord', 'u1', 'hi', 60_000), true);
    });

    it('does not treat every DM as a command when the prefix is empty', () => {
        assert.equal(new DmGate('').admit('discord', 'u1', 'link', 0), true);
    });
});

describe('nickChange', () => {
    it('copies a Discord nickname that differs', () => {
        assert.deepEqual(nickChange('Ada', null, undefined), { nick: 'Ada' });
        assert.deepEqual(nickChange('Ada', 'Bob', undefined), { nick: 'Ada' });
        assert.equal(nickChange('Ada', 'Ada', undefined), null);
    });

    it('clears only a nickname the sync wrote', () => {
        assert.deepEqual(nickChange(null, 'Ada', 'Ada'), { nick: null });
        assert.equal(nickChange(null, 'Own', 'Ada'), null);
        assert.equal(nickChange(null, 'Own', undefined), null);
        assert.equal(nickChange(null, null, 'Ada'), null);
    });

    it('remembers written nicknames and forgets cleared ones', () => {
        const memory = new NickMemory();
        memory.remember('k', 'Ada');
        assert.equal(memory.get('k'), 'Ada');
        memory.remember('k', null);
        assert.equal(memory.get('k'), undefined);
    });
});

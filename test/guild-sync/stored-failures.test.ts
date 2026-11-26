import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    FAILURES_BEFORE_BACKOFF,
    StoredFailureLedger,
    type FailureCountStore,
} from '../../src/guild-sync/failures';

const NOW = new Date('2026-11-26T05:00:00Z');

class MemoryStore implements FailureCountStore {
    rows = new Map<string, number>();
    failLoad = false;
    failWrites = false;

    async loadFailureCounts() {
        if (this.failLoad) throw new Error('db down');
        return [...this.rows].map(([key, count]) => ({ key, count }));
    }

    async saveFailureCount(key: string, count: number) {
        if (this.failWrites) throw new Error('db down');
        this.rows.set(key, count);
    }

    async clearFailureCount(key: string) {
        if (this.failWrites) throw new Error('db down');
        this.rows.delete(key);
    }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('failure counts across a restart', () => {
    it('keeps the count but retries once after a restart', async () => {
        const store = new MemoryStore();
        const before = new StoredFailureLedger(store, () => undefined);
        for (let i = 0; i < FAILURES_BEFORE_BACKOFF + 1; i++) {
            before.failed('create:thread:p', NOW);
        }
        await settle();
        assert.equal(before.blocked('create:thread:p', NOW), true);
        const after = new StoredFailureLedger(store, () => undefined);
        await after.load();
        assert.equal(
            after.count('create:thread:p'),
            FAILURES_BEFORE_BACKOFF + 1
        );
        assert.equal(after.blocked('create:thread:p', NOW), false);
    });

    it('forgets a count once the op succeeds', async () => {
        const store = new MemoryStore();
        const ledger = new StoredFailureLedger(store, () => undefined);
        ledger.failed('k', NOW);
        await settle();
        ledger.succeeded('k');
        await settle();
        assert.equal(store.rows.has('k'), false);
        assert.equal(ledger.count('k'), 0);
    });

    it('starts empty and warns when the counts cannot be read', async () => {
        const store = new MemoryStore();
        store.rows.set('k', 4);
        store.failLoad = true;
        const warnings: string[] = [];
        const ledger = new StoredFailureLedger(store, (m) => warnings.push(m));
        await ledger.load();
        assert.equal(ledger.count('k'), 0);
        assert.match(warnings[0], /could not read saved failure counts/);
    });

    it('still counts in memory when a save fails, and warns', async () => {
        const store = new MemoryStore();
        store.failWrites = true;
        const warnings: string[] = [];
        const ledger = new StoredFailureLedger(store, (m) => warnings.push(m));
        ledger.failed('k', NOW);
        await settle();
        assert.equal(ledger.count('k'), 1);
        assert.match(warnings[0], /could not save a failure count/);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HistoryEditor } from '../../src/history/editor';
import {
    CODE_TTL_MS,
    MAX_FAILURES_PER_HOUR,
    handleDm,
    hashCode,
    generateCode,
    type DmInput,
    type FlowDeps,
} from '../../src/identity/flow';
import type {
    AccountPair,
    IdentityStore,
    PendingLink,
    Side,
} from '../../src/identity/store';
import { FakeLinker } from '../guild-sync/fake-store';
import { FakeHistoryPorts, FakeHistoryStore } from '../history/fakes';

class FakeIdentityStore implements IdentityStore {
    pairs: AccountPair[] = [];
    codes: {
        hash: string;
        side: Side;
        userId: string;
        expiresAt: Date;
        used: boolean;
    }[] = [];
    pending: PendingLink[] = [];
    failures: { side: Side; userId: string; at: Date }[] = [];

    async pairFor(side: Side, userId: string) {
        const key = side === 'discord' ? 'discordUserId' : 'fluxerUserId';
        return this.pairs.find((p) => p[key] === userId) ?? null;
    }
    async savePair(pair: AccountPair) {
        this.pairs.push(pair);
    }
    async deletePair(side: Side, userId: string) {
        const pair = await this.pairFor(side, userId);
        this.pairs = this.pairs.filter((p) => p !== pair);
        return pair;
    }
    async listPairs() {
        return this.pairs;
    }
    async saveCode(hash: string, side: Side, userId: string, expiresAt: Date) {
        this.codes.push({ hash, side, userId, expiresAt, used: false });
    }
    async takeCode(hash: string, side: Side, now: Date) {
        const code = this.codes.find(
            (c) =>
                c.hash === hash &&
                c.side === side &&
                !c.used &&
                c.expiresAt > now
        );
        if (!code) return null;
        code.used = true;
        return code.userId;
    }
    async savePending(p: PendingLink) {
        this.pending = this.pending.filter(
            (x) =>
                !(
                    x.confirmSide === p.confirmSide &&
                    x.confirmUserId === p.confirmUserId
                )
        );
        this.pending.push(p);
    }
    async takePending(side: Side, userId: string, now: Date) {
        const p = this.pending.find(
            (x) => x.confirmSide === side && x.confirmUserId === userId
        );
        this.pending = this.pending.filter((x) => x !== p);
        return p && p.expiresAt > now ? p : null;
    }
    async recordFailure(side: Side, userId: string, at: Date) {
        this.failures.push({ side, userId, at });
    }
    async failuresSince(side: Side, userId: string, since: Date) {
        return this.failures.filter(
            (f) => f.side === side && f.userId === userId && f.at >= since
        ).length;
    }
}

function setup() {
    const store = new FakeIdentityStore();
    const history = new FakeHistoryStore();
    const ports = new FakeHistoryPorts();
    const links = new FakeLinker();
    const state = { now: new Date('2026-11-25T12:00:00Z'), code: 'ABCD2345' };
    const linked: AccountPair[] = [];
    const deps: FlowDeps = {
        store,
        nameOf: async (side, id) => `${side}-${id}`,
        history: {
            editor: new HistoryEditor(history, links, ports),
            setOptOut: (id, out, now) => history.setOptOut(id, out, now),
        },
        onLinked: async (pair) => {
            linked.push(pair);
        },
        now: () => state.now,
        newCode: () => state.code,
    };
    const dm = (side: Side, userId: string, text: string) =>
        handleDm({ side, userId, text } satisfies DmInput, deps);
    return { store, history, ports, links, state, linked, deps, dm };
}

describe('account linking', () => {
    it('links two accounts after the code owner confirms', async () => {
        const s = setup();
        const [code] = await s.dm('discord', 'd1', 'link');
        assert.match(code.text, /ABCD2345/);
        const redeem = await s.dm('fluxer', 'f1', 'link abcd2345');
        assert.deepEqual(
            redeem.map((r) => `${r.side}:${r.userId}`),
            ['fluxer:f1', 'discord:d1']
        );
        assert.match(redeem[1].text, /Fluxer user \*\*fluxer-f1\*\*/);
        assert.deepEqual(s.store.pairs, []);
        const done = await s.dm('discord', 'd1', 'yes');
        assert.deepEqual(s.store.pairs, [
            { discordUserId: 'd1', fluxerUserId: 'f1' },
        ]);
        assert.deepEqual(s.linked, s.store.pairs);
        assert.deepEqual(
            done.map((r) => r.userId),
            ['d1', 'f1']
        );
    });

    it('works the other way round, starting on Fluxer', async () => {
        const s = setup();
        await s.dm('fluxer', 'f1', 'link');
        await s.dm('discord', 'd1', 'link ABCD2345');
        await s.dm('fluxer', 'f1', 'yes');
        assert.deepEqual(s.store.pairs, [
            { discordUserId: 'd1', fluxerUserId: 'f1' },
        ]);
    });

    it('lets only the code owner confirm, and a no cancels', async () => {
        const s = setup();
        await s.dm('discord', 'd1', 'link');
        await s.dm('fluxer', 'f1', 'link ABCD2345');
        const stranger = await s.dm('fluxer', 'f1', 'yes');
        assert.match(stranger[0].text, /nothing to confirm/);
        await s.dm('discord', 'd1', 'no');
        assert.deepEqual(s.store.pairs, []);
    });

    it('refuses a code from the same platform, a used code and an expired code', async () => {
        const s = setup();
        await s.dm('discord', 'd1', 'link');
        const same = await s.dm('discord', 'd2', 'link ABCD2345');
        assert.match(same[0].text, /unknown, used or expired/);
        await s.dm('fluxer', 'f1', 'link ABCD2345');
        const reused = await s.dm('fluxer', 'f2', 'link ABCD2345');
        assert.match(reused[0].text, /unknown, used or expired/);

        const t = setup();
        await t.dm('discord', 'd1', 'link');
        t.state.now = new Date(t.state.now.getTime() + CODE_TTL_MS + 1);
        const late = await t.dm('fluxer', 'f1', 'link ABCD2345');
        assert.match(late[0].text, /unknown, used or expired/);
    });

    it('locks an account after repeated wrong codes', async () => {
        const s = setup();
        for (let i = 0; i < MAX_FAILURES_PER_HOUR; i++)
            await s.dm('fluxer', 'f1', 'link ZZZZZZZZ');
        await s.dm('discord', 'd1', 'link');
        const locked = await s.dm('fluxer', 'f1', 'link ABCD2345');
        assert.match(locked[0].text, /Too many failed attempts/);
    });

    it('refuses to link an account twice, and unlinks on request', async () => {
        const s = setup();
        s.store.pairs.push({ discordUserId: 'd1', fluxerUserId: 'f1' });
        const again = await s.dm('discord', 'd1', 'link');
        assert.match(again[0].text, /already linked/);
        const gone = await s.dm('fluxer', 'f1', 'unlink');
        assert.deepEqual(s.store.pairs, []);
        assert.equal(gone.length, 2);
    });

    it('stores only a hash of each code', async () => {
        const s = setup();
        await s.dm('discord', 'd1', 'link');
        assert.equal(s.store.codes[0]?.hash, hashCode('ABCD2345'));
        assert.ok(!JSON.stringify(s.store.codes).includes('ABCD2345'));
        assert.match(generateCode(), /^[A-HJ-NP-Z2-9]{8}$/);
    });

    it('answers anything else with the command list', async () => {
        const s = setup();
        const [help] = await s.dm('discord', 'd1', 'hello?');
        assert.match(help.text, /history-optout/);
    });
});

describe('history requests by DM', () => {
    it('opts a member out from either platform once linked', async () => {
        const s = setup();
        await s.dm('discord', 'd1', 'history-optout');
        assert.ok(s.history.optOuts.has('d1'));
        const unlinked = await s.dm('fluxer', 'f9', 'history-optin');
        assert.match(unlinked[0].text, /Link your accounts first/);
        s.store.pairs.push({ discordUserId: 'd1', fluxerUserId: 'f1' });
        await s.dm('fluxer', 'f1', 'history-optin');
        assert.ok(!s.history.optOuts.has('d1'));
    });

    it('edits and deletes only the member own imported copies', async () => {
        const s = setup();
        await s.history.ensureJob('link-1', 'channel', '10', null);
        const job = s.history.job('10');
        await s.history.updateJob(job.id, {
            importWebhook: { id: 'import-f10', token: 't' },
        });
        await s.history.startMessage({
            discordMessageId: '11',
            jobId: job.id,
            discordAuthorId: 'd1',
            fluxerMessageId: null,
            fluxerTargetId: 'f10',
            inThread: false,
            webhookId: 'import-f10',
        });
        await s.history.finishMessage('11', '555555');
        s.store.pairs.push({ discordUserId: 'd1', fluxerUserId: 'f1' });
        const notMine = await s.dm('discord', 'd2', 'delete 555555');
        assert.match(notMine[0].text, /not imported from one of your messages/);
        await s.dm('fluxer', 'f1', 'edit 555555 fixed typo');
        await s.dm('discord', 'd1', 'delete 555555');
        assert.deepEqual(s.ports.edits, [
            'edit import-f10 555555 fixed typo\n*Edited by its author*',
            'delete import-f10 555555',
        ]);
        assert.deepEqual(s.history.messages, []);
    });
});

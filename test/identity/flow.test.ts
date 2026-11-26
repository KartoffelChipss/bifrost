import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HistoryEditor } from '../../src/history/editor';
import { contentHash } from '../../src/history/format';
import {
    CODE_TTL_MS,
    MAX_FAILURES_PER_HOUR,
    handleDm,
    hashCode,
    generateCode,
    describeUser,
    type DmInput,
    type FlowDeps,
} from '../../src/identity/flow';
import type {
    AccountPair,
    IdentityStore,
    PendingLink,
    Side,
} from '../../src/identity/store';
import { createRecordingLogger } from '../addons/fakes';
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
    /** Set to make the next savePair lose a race. */
    conflictOnSave = false;
    purged: { now: Date; failuresBefore: Date }[] = [];

    async savePair(pair: AccountPair) {
        if (this.conflictOnSave) return false;
        this.pairs.push(pair);
        return true;
    }
    async purgeExpired(now: Date, failuresBefore: Date) {
        this.purged.push({ now, failuresBefore });
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
    const unlinked: AccountPair[] = [];
    const logger = createRecordingLogger();
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
        onUnlinked: async (pair) => {
            unlinked.push(pair);
        },
        now: () => state.now,
        newCode: () => state.code,
        logger,
    };
    const dm = (side: Side, userId: string, text: string) =>
        handleDm({ side, userId, text } satisfies DmInput, deps);
    return {
        store,
        history,
        ports,
        links,
        state,
        linked,
        unlinked,
        deps,
        dm,
        logger,
    };
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
        assert.deepEqual(s.unlinked, [
            { discordUserId: 'd1', fluxerUserId: 'f1' },
        ]);
    });

    it('stores only a hash of each code', async () => {
        const s = setup();
        await s.dm('discord', 'd1', 'link');
        assert.equal(s.store.codes[0]?.hash, hashCode('ABCD2345'));
        assert.ok(!JSON.stringify(s.store.codes).includes('ABCD2345'));
        assert.match(generateCode(), /^[A-HJ-NP-Z2-9]{8}$/);
    });

    it('reports a link that lost a race instead of failing', async () => {
        const s = setup();
        await s.dm('discord', 'd1', 'link');
        await s.dm('fluxer', 'f1', 'link ABCD2345');
        s.store.conflictOnSave = true;
        const done = await s.dm('discord', 'd1', 'yes');
        assert.equal(done.length, 2);
        for (const reply of done)
            assert.match(reply.text, /linked in the meantime/);
        assert.deepEqual(s.store.pairs, []);
        assert.deepEqual(s.linked, []);
    });

    it('announces a confirmed link, such as to start a mention fix-up', async () => {
        const s = setup();
        const announced: AccountPair[] = [];
        const deps: FlowDeps = {
            ...s.deps,
            accountLinked: async (pair) => {
                announced.push(pair);
            },
        };
        await handleDm({ side: 'discord', userId: 'd1', text: 'link' }, deps);
        await handleDm(
            { side: 'fluxer', userId: 'f1', text: 'link ABCD2345' },
            deps
        );
        assert.deepEqual(announced, []);
        await handleDm({ side: 'discord', userId: 'd1', text: 'yes' }, deps);
        assert.deepEqual(announced, [
            { discordUserId: 'd1', fluxerUserId: 'f1' },
        ]);
    });

    it('keeps the link when its announcement fails, and logs it', async () => {
        const s = setup();
        const deps: FlowDeps = {
            ...s.deps,
            accountLinked: async () => {
                throw new Error('database down');
            },
        };
        await handleDm({ side: 'discord', userId: 'd1', text: 'link' }, deps);
        await handleDm(
            { side: 'fluxer', userId: 'f1', text: 'link ABCD2345' },
            deps
        );
        const done = await handleDm(
            { side: 'discord', userId: 'd1', text: 'yes' },
            deps
        );
        assert.match(done[0].text, /Your accounts are linked/);
        assert.deepEqual(s.linked, s.store.pairs);
        assert.match(
            s.logger.entries[0]?.message ?? '',
            /announce the link of d1/
        );
    });

    it('announces nothing when a link is cancelled or lost a race', async () => {
        const s = setup();
        const announced: AccountPair[] = [];
        const deps: FlowDeps = {
            ...s.deps,
            accountLinked: async (pair) => {
                announced.push(pair);
            },
        };
        await handleDm({ side: 'discord', userId: 'd1', text: 'link' }, deps);
        await handleDm(
            { side: 'fluxer', userId: 'f1', text: 'link ABCD2345' },
            deps
        );
        await handleDm({ side: 'discord', userId: 'd1', text: 'no' }, deps);
        assert.deepEqual(announced, []);
    });

    it('answers anything else with the command list', async () => {
        const s = setup();
        const [help] = await s.dm('discord', 'd1', 'hello?');
        assert.match(help.text, /history-optout/);
    });
});

describe('lookup failures', () => {
    it('names the redeeming account by ID when its lookup fails', async () => {
        const s = setup();
        const deps: FlowDeps = {
            ...s.deps,
            nameOf: async () => {
                throw new Error('Unknown User');
            },
        };
        await handleDm({ side: 'discord', userId: 'd1', text: 'link' }, deps);
        const redeem = await handleDm(
            { side: 'fluxer', userId: 'f1', text: 'link ABCD2345' },
            deps
        );
        assert.match(redeem[1].text, /\*\*user ID f1\*\*/);
        assert.equal(s.logger.entries.length, 1);
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

    async function importedCopy(s: ReturnType<typeof setup>) {
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
    }

    it('answers and logs a copy that cannot be changed instead of throwing', async () => {
        const s = setup();
        await importedCopy(s);
        const gone = async () => {
            throw new Error('Unknown Message');
        };
        s.ports.editCopy = gone;
        s.ports.deleteCopy = gone;
        for (const text of ['edit 555555 new', 'delete 555555']) {
            const [answer] = await s.dm('discord', 'd1', text);
            assert.match(answer.text, /could not be changed/);
        }
        assert.equal(s.logger.entries.length, 2);
        assert.equal(s.history.messages.length, 1);
    });

    it('clears the mentions of a copy its author edited, so no fix-up renders over it', async () => {
        const s = setup();
        await importedCopy(s);
        await s.history.recordMentions('11', ['500']);
        await s.dm('discord', 'd1', 'edit 555555 my own words');
        assert.deepEqual(s.history.mentions.get('11'), []);
        assert.equal(
            s.history.messages[0]?.contentHash,
            contentHash('my own words\n*Edited by its author*')
        );
    });

    it('cuts an edit to the Fluxer limit and keeps the edit marker', async () => {
        const s = setup();
        await importedCopy(s);
        await s.dm('discord', 'd1', `edit 555555 ${'x'.repeat(5000)}`);
        const sent = s.ports.edits[0].slice('edit import-f10 555555 '.length);
        assert.equal(sent.length, 4000);
        assert.ok(sent.endsWith('…\n*Edited by its author*'));
    });
});

describe('describeUser', () => {
    it('shows the username and ID before the display name', () => {
        assert.equal(
            describeUser({ id: '42', username: 'ada', displayName: 'Ada L' }),
            '@ada (ID 42), display name "Ada L"'
        );
        assert.equal(
            describeUser({ id: '42', username: 'ada', displayName: null }),
            '@ada (ID 42)'
        );
    });

    it('escapes Markdown so a name cannot restyle the question', () => {
        const text = describeUser({
            id: '7',
            username: 'eve_x',
            displayName: '**[admin](https://x)**\nline',
        });
        assert.ok(!/(^|[^\\])\*\*/.test(text), text);
        assert.match(text, /eve\\_x/);
        assert.match(text, /\\\[admin\\\]/);
        assert.ok(!text.includes('\n'));
    });
});

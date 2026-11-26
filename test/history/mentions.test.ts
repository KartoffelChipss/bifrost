import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    BACKFILL_PAUSE_MS,
    MentionBackfill,
    justBefore,
    settledBy,
} from '../../src/history/backfill';
import {
    HistoryEditor,
    copyText,
    type EditorThreads,
} from '../../src/history/editor';
import {
    FIXUP_EDIT_INTERVAL_MS,
    MAX_FIXUP_RETRIES,
    MentionFixups,
    rendersAs,
} from '../../src/history/fixup';
import { CopyFormatter, contentHash } from '../../src/history/format';
import type { HistoryMode } from '../../src/history/importer';
import {
    MAX_MENTIONS_PER_MESSAGE,
    WorkBudget,
    capMentions,
    renderedMentions,
} from '../../src/history/mentions';
import {
    FIXUP_DELAY_MS,
    MentionWork,
    budgetFor,
    mentionLinkHook,
} from '../../src/history/mentionWork';
import { createRecordingLogger } from '../addons/fakes';
import { FakeLinker } from '../guild-sync/fake-store';
import { FakeHistoryPorts, FakeHistoryStore, FakeMentionStore } from './fakes';

const LINK = 'link-1';
const USER = '500';
const LINKED_AT = new Date('2026-11-25T11:00:00Z');

interface CopyOptions {
    /** The source's text; `<@id>` renders as a mention once id is linked. */
    readonly text?: string;
    /** Recorded mentions, or null for a copy imported before recording. */
    readonly recorded?: string[] | null;
    readonly author?: string;
    /** Records no content hash, as for copies from before hashes. */
    readonly noHash?: boolean;
    readonly channel?: string;
}

/** History with one done channel job, mention stores and both workers. */
async function world() {
    const store = new FakeHistoryStore();
    const ports = new FakeHistoryPorts();
    const links = new FakeLinker();
    const mentions = new FakeMentionStore(store);
    const logger = createRecordingLogger();
    const state = {
        mode: 'apply' as HistoryMode,
        held: true,
        clock: Date.parse('2026-11-25T12:00:00Z'),
        /** Users fidelity renders as real mentions. */
        rendered: new Set<string>(),
    };
    // Fidelity in miniature: a linked user's mention maps, others stay text.
    ports.payload = async (raw) => {
        const { text } = raw as { text: string };
        const content = text.replace(/<@(\d+)>/g, (_, id: string) =>
            state.rendered.has(id) ? `<@f${id}>` : `@user${id}`
        );
        return { content, username: 'author', avatarURL: '' };
    };
    for (const id of ['10', '20']) {
        await store.ensureJob(LINK, 'channel', id, null);
        await store.updateJob(store.job(id).id, {
            status: 'done',
            fluxerId: `f${id}`,
            importWebhook: { id: `import-f${id}`, token: 'secret' },
        });
    }
    const reports: string[] = [];
    const pauses: number[] = [];
    const states: string[] = [];
    const threads: EditorThreads = {
        discordState: async () => ({ archived: true, locked: false }),
        setState: async (linkId, id, flags) => {
            states.push(`${linkId} ${id} ${JSON.stringify(flags)}`);
        },
    };
    const formatter = new CopyFormatter({ store, ports, commandPrefix: '!b ' });
    const editor = new HistoryEditor(store, links, ports, threads);
    const now = () => new Date(state.clock);
    const pause = async (ms: number) => {
        pauses.push(ms);
    };
    const common = { mentions, store, ports, formatter, pause, now, logger };
    const fixups = new MentionFixups({
        ...common,
        editor,
        mode: async () => state.mode,
        report: async (_link, _key, text) => {
            reports.push(text);
        },
    });
    const newBackfill = () => new MentionBackfill(common);
    const budget = (pages = 1_000, copies = 1_000) =>
        new WorkBudget(pages, copies, Number.MAX_SAFE_INTEGER, () => 0);
    const held = async () => state.held;

    /** An imported copy of a new Discord message, sent before any link. */
    const copy = async (id: string, options: CopyOptions = {}) => {
        const channel = options.channel ?? '10';
        const text = options.text ?? `hi <@${USER}>`;
        const author = options.author ?? 'author';
        ports.add(channel, id, {
            authorId: author,
            mentionIds: renderedMentions(text, [], null),
            raw: { id, text },
        });
        const message = (ports.discord.get(channel) ?? []).find(
            (m) => m.id === id
        );
        assert.ok(message);
        const payload = await formatter.build(message, LINK);
        await store.startMessage({
            discordMessageId: id,
            jobId: store.job(channel).id,
            discordAuthorId: author,
            fluxerMessageId: `copy-${id}`,
            fluxerTargetId: `f${channel}`,
            inThread: false,
            webhookId: `import-f${channel}`,
            contentHash: options.noHash
                ? null
                : contentHash(copyText(payload.content)),
        });
        const recorded =
            options.recorded === undefined
                ? message.mentionIds
                : options.recorded;
        if (recorded) store.mentions.set(id, [...recorded]);
    };

    /** USER links accounts: fidelity maps them, and a fix-up is due. */
    const link = async (user = USER) => {
        state.rendered.add(user);
        mentions.linked.set(user, LINKED_AT);
        await mentions.ensureFixups([LINK], user, new Date(0), now());
    };

    const edited = () =>
        ports.edits.map((e) => e.split(' ').slice(0, 3).join(' '));

    return {
        store,
        ports,
        mentions,
        logger,
        state,
        reports,
        pauses,
        states,
        fixups,
        newBackfill,
        budget,
        held,
        copy,
        link,
        edited,
    };
}

describe('renderedMentions', () => {
    it('takes text tokens and the mentions list, without repeats', () => {
        assert.deepEqual(
            renderedMentions('hi <@1> and <@!2> and <@1>', ['3', '2'], null),
            ['1', '2', '3']
        );
    });

    it('leaves out the replied-to user unless the text names them', () => {
        assert.deepEqual(renderedMentions('thanks', ['7'], '7'), []);
        assert.deepEqual(renderedMentions('thanks <@7>', ['7'], '7'), ['7']);
    });

    it('records at most MAX_MENTIONS_PER_MESSAGE users, all snowflakes', () => {
        const text = Array.from({ length: 80 }, (_, i) => `<@${i + 1}>`).join(
            ' '
        );
        const ids = renderedMentions(text, [], null);
        assert.equal(ids.length, MAX_MENTIONS_PER_MESSAGE);
        assert.deepEqual(capMentions(['1', 'x', '1', '2']), ['1', '2']);
    });
});

describe('mention backfill', () => {
    it('reads sources back a page of 100 at a time by ID range', async () => {
        const w = await world();
        for (let i = 0; i < 250; i++) {
            const id = String(1_000 + i);
            await w.copy(id, {
                text: i % 2 === 0 ? `hi <@${USER}>` : 'plain',
                recorded: null,
            });
        }
        const more = await w.newBackfill().run(LINK, w.budget());
        assert.equal(more, false);
        assert.deepEqual(w.ports.listings, [
            '10 999 100',
            '10 1099 100',
            '10 1199 100',
        ]);
        assert.equal(w.store.mentions.size, 250);
        assert.deepEqual(w.store.mentions.get('1000'), [USER]);
        assert.deepEqual(w.store.mentions.get('1001'), []);
        assert.equal(await w.mentions.scanLeft(LINK), false);
        assert.deepEqual(
            w.pauses,
            Array.from({ length: 3 }, () => BACKFILL_PAUSE_MS)
        );
    });

    it('resumes after a restart where the last page ended', async () => {
        const w = await world();
        for (let i = 0; i < 150; i++)
            await w.copy(String(1_000 + i), { recorded: null });
        assert.equal(await w.newBackfill().run(LINK, w.budget(1)), true);
        assert.equal(w.store.mentions.size, 100);
        // A new process: nothing in memory carries over.
        assert.equal(await w.newBackfill().run(LINK, w.budget(1)), false);
        assert.deepEqual(w.ports.listings, ['10 999 100', '10 1099 100']);
        assert.equal(w.store.mentions.size, 150);
    });

    it('skips copies whose author opted out, and copies whose source is gone', async () => {
        const w = await world();
        await w.copy('11', { author: 'shy', recorded: null });
        await w.copy('12', { recorded: null });
        await w.copy('13', { recorded: null });
        w.store.optOuts.add('shy');
        w.ports.discord.set(
            '10',
            (w.ports.discord.get('10') ?? []).filter((m) => m.id !== '12')
        );
        await w.newBackfill().run(LINK, w.budget());
        assert.deepEqual(w.store.mentions.get('11'), []);
        assert.deepEqual(w.store.mentions.get('12'), []);
        assert.deepEqual(w.store.mentions.get('13'), [USER]);
    });

    it('leaves copies past a full page for the next one', () => {
        const page = ['1', '2', '4'].map((id) => ({
            id,
            authorId: 'a',
            createdAt: new Date(0),
            copyable: true,
            attachments: 0,
            webhookId: null,
            ownWebhook: false,
            reply: null,
            reactions: [],
            raw: null,
        }));
        const copies = ['1', '3', '4', '5'].map((id) => ({
            discordMessageId: id,
            discordAuthorId: 'a',
        }));
        const full = settledBy(copies, page, 3);
        assert.deepEqual(
            full.found.map((m) => m.id),
            ['1', '4']
        );
        assert.deepEqual(full.gone, ['3']);
        assert.deepEqual(settledBy(copies, page, 100).gone, ['3', '5']);
        assert.equal(justBefore('100'), '99');
    });

    it('retries a temporary read error later and gives up on a lost channel', async () => {
        const w = await world();
        await w.copy('11', { recorded: null });
        w.ports.listFailure = Object.assign(new Error('Bad Gateway'), {
            status: 502,
        });
        await assert.rejects(w.newBackfill().run(LINK, w.budget()));
        assert.equal(w.store.mentions.size, 0);
        w.ports.listFailure = Object.assign(new Error('Unknown Channel'), {
            status: 404,
            code: 10003,
        });
        assert.equal(await w.newBackfill().run(LINK, w.budget()), false);
        assert.deepEqual(w.store.mentions.get('11'), []);
        assert.match(w.logger.entries[0]?.message ?? '', /cannot be read back/);
    });
});

describe('mention fix-ups', () => {
    it('starts on a link, waits out the fidelity cache, then edits', async () => {
        const w = await world();
        await w.copy('11');
        w.mentions.linked.set(USER, LINKED_AT);
        w.state.rendered.add(USER);
        const hook = mentionLinkHook({
            mentions: w.mentions,
            listGuildLinks: async () => [{ id: LINK }],
            now: () => new Date(w.state.clock),
        });
        await hook({ discordUserId: USER });
        const fixup = w.mentions.fixup(USER);
        assert.equal(fixup.status, 'pending');
        assert.equal(fixup.notBefore.getTime(), w.state.clock + FIXUP_DELAY_MS);
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.ports.edits, []);
        w.state.clock += FIXUP_DELAY_MS;
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.ports.edits, [
            `edit import-f10 copy-11 hi <@f${USER}>\n*Originally posted 2024-03-01 18:22 UTC*`,
        ]);
        assert.equal(w.mentions.fixup(USER).status, 'done');
        assert.deepEqual(w.reports, [
            `History: updated 1 imported copy that mentions <@${USER}>, who linked their Fluxer account.`,
        ]);
    });

    it('edits only copies whose rendering changes', async () => {
        const w = await world();
        await w.copy('11');
        await w.copy('12', { text: `<@${USER}> was here`, noHash: true });
        await w.copy('13', { text: `hi <@${USER}>`, recorded: ['999'] });
        await w.link();
        // Imported after the link: it already renders the mention.
        await w.copy('14');
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.edited(), [
            'edit import-f10 copy-11',
            'edit import-f10 copy-12',
        ]);
        assert.equal(w.mentions.fixup(USER).changed, 2);
        assert.deepEqual(
            w.pauses.filter((p) => p === FIXUP_EDIT_INTERVAL_MS),
            [FIXUP_EDIT_INTERVAL_MS, FIXUP_EDIT_INTERVAL_MS]
        );
    });

    it('edits nothing on a second run: every copy now matches', async () => {
        const w = await world();
        await w.copy('11');
        await w.copy('12');
        await w.link();
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.equal(w.ports.edits.length, 2);
        // Run it all again, as if started over.
        w.mentions.fixups = w.mentions.fixups.map((f) => ({
            ...f,
            status: 'pending',
            doneTo: '0',
            changed: 0,
        }));
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.equal(w.ports.edits.length, 2);
        assert.equal(w.mentions.fixup(USER).changed, 0);
        assert.equal(w.mentions.fixup(USER).status, 'done');
        assert.equal(w.reports.length, 1);
    });

    it('opens a closed Fluxer thread for the edit and closes it again', async () => {
        const w = await world();
        await w.copy('11');
        w.store.messages = w.store.messages.map((m) => ({
            ...m,
            inThread: true,
            fluxerTargetId: 'thread-of-f10',
        }));
        const original = w.ports.editCopy.bind(w.ports);
        let refusals = 1;
        w.ports.editCopy = async (target, id, content) => {
            if (refusals-- > 0)
                throw Object.assign(new Error('THREAD_ARCHIVED'), {
                    statusCode: 400,
                    code: 'THREAD_ARCHIVED',
                });
            return original(target, id, content);
        };
        await w.link();
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.edited(), ['edit import-f10 copy-11']);
        assert.deepEqual(w.states, [
            'link-1 thread-of-f10 {"archived":false,"locked":false}',
            'link-1 thread-of-f10 {"archived":true,"locked":true}',
        ]);
    });

    it('counts instead of editing in dry-run, then edits in apply', async () => {
        const w = await world();
        await w.copy('11');
        await w.link();
        w.state.mode = 'dry-run';
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.ports.edits, []);
        assert.equal(w.mentions.fixup(USER).status, 'previewed');
        assert.match(w.reports[0] ?? '', /dry-run\): would update 1/);
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.equal(w.reports.length, 1);
        w.state.mode = 'apply';
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.edited(), ['edit import-f10 copy-11']);
        assert.equal(w.mentions.fixup(USER).status, 'done');
    });

    it('does nothing in read-only, as with the kill switch on', async () => {
        const w = await world();
        await w.copy('11');
        await w.copy('12', { recorded: null });
        await w.link();
        w.state.mode = 'read-only';
        const work = new MentionWork({
            mentions: w.mentions,
            backfill: w.newBackfill(),
            fixups: w.fixups,
            listGuildLinks: async () => [{ id: LINK }],
            mode: async () => w.state.mode,
            now: () => 0,
            logger: w.logger,
        });
        assert.equal(await work.run(false, w.held), false);
        assert.deepEqual(w.ports.edits, []);
        assert.deepEqual(w.ports.fetches, []);
        assert.deepEqual(w.ports.listings, []);
        assert.equal(w.mentions.fixup(USER).doneTo, '0');
    });

    it('stops before an edit once writes are off or the leader lock is lost', async () => {
        const w = await world();
        await w.copy('11');
        await w.link();
        w.state.held = false;
        assert.equal(await w.fixups.run(LINK, w.budget(), w.held), true);
        assert.deepEqual(w.ports.edits, []);
        assert.equal(w.mentions.fixup(USER).doneTo, '0');
        w.state.held = true;
        let reads = 0;
        const fixups = new MentionFixups({
            ...depsOf(w),
            mode: async () => (reads++ === 0 ? 'apply' : 'dry-run'),
        });
        assert.equal(await fixups.run(LINK, w.budget(), w.held), true);
        assert.deepEqual(w.ports.edits, []);
    });

    it('fixes every copy for a member linked while the backfill runs', async () => {
        const w = await world();
        // Imported before mentions were recorded, oldest first.
        for (let i = 0; i < 150; i++)
            await w.copy(String(1_000 + i), {
                text: i === 120 ? `late <@${USER}>` : 'plain',
                recorded: null,
            });
        await w.copy('5000');
        await w.link();
        // The fix-up gets ahead of the backfill and must not finish.
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.edited(), ['edit import-f10 copy-5000']);
        assert.equal(w.mentions.fixup(USER).status, 'pending');
        assert.deepEqual(w.reports, []);
        await w.newBackfill().run(LINK, w.budget());
        assert.equal(w.mentions.fixup(USER).doneTo, '1119');
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.edited(), [
            'edit import-f10 copy-5000',
            'edit import-f10 copy-1120',
        ]);
        assert.equal(w.mentions.fixup(USER).status, 'done');
        assert.match(w.reports[0] ?? '', /updated 2 imported copies/);
    });

    it('leaves copies alone after an unlink, and for an opted-out author', async () => {
        const w = await world();
        await w.copy('11', { author: 'shy' });
        await w.copy('12');
        await w.link();
        w.store.optOuts.add('shy');
        w.mentions.linked.delete(USER);
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.ports.edits, []);
        w.mentions.linked.set(USER, LINKED_AT);
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.deepEqual(w.edited(), ['edit import-f10 copy-12']);
    });

    it('starts over for a new link, and keeps progress for the same one', async () => {
        const w = await world();
        await w.copy('11');
        await w.link();
        await w.mentions.saveFixup(
            w.mentions.fixup(USER),
            { status: 'pending', doneTo: '11', changed: 1, failures: 0 },
            new Date()
        );
        await w.mentions.ensureFixups([LINK], null, new Date(0), new Date());
        assert.equal(w.mentions.fixup(USER).doneTo, '11');
        w.mentions.linked.set(USER, new Date('2026-11-25T11:30:00Z'));
        await w.mentions.ensureFixups([LINK], null, new Date(0), new Date());
        assert.equal(w.mentions.fixup(USER).doneTo, '0');
    });

    it('retries a temporary error, then skips the copy; skips a gone one at once', async () => {
        const w = await world();
        await w.copy('11');
        await w.copy('12');
        await w.link();
        w.ports.editCopy = async (_target, id) => {
            if (id === 'copy-11')
                throw Object.assign(new Error('Unknown Message'), {
                    statusCode: 404,
                    code: 'UNKNOWN_MESSAGE',
                });
            throw Object.assign(new Error('Bad Gateway'), { statusCode: 502 });
        };
        await w.fixups.run(LINK, w.budget(), w.held);
        assert.equal(w.mentions.fixup(USER).doneTo, '11');
        assert.equal(w.mentions.fixup(USER).failures, 1);
        for (let i = 1; i < MAX_FIXUP_RETRIES; i++)
            await w.fixups.run(LINK, w.budget(), w.held);
        assert.equal(w.mentions.fixup(USER).status, 'done');
        assert.equal(w.mentions.fixup(USER).changed, 0);
        assert.equal(
            w.logger.entries.filter((e) => /Skipped/.test(e.message)).length,
            2
        );
    });

    it('stays within its budget and says work is left', async () => {
        const w = await world();
        await w.copy('11');
        await w.copy('12');
        await w.copy('13');
        await w.link();
        assert.equal(await w.fixups.run(LINK, w.budget(0, 2), w.held), true);
        assert.equal(w.ports.edits.length, 2);
        assert.equal(w.mentions.fixup(USER).doneTo, '12');
    });
});

describe('rendersAs', () => {
    const copy = (hash: string | null) => ({
        discordMessageId: '1',
        jobId: 'j',
        discordAuthorId: 'a',
        fluxerMessageId: 'c',
        fluxerTargetId: 'f',
        inThread: false,
        webhookId: 'w',
        contentHash: hash,
    });
    const payload = {
        content: 'hi\n*Originally posted 2024-03-01 18:22 UTC*',
        username: 'a',
        avatarURL: '',
        attachments: [{ url: 'https://x/f.png', name: 'f.png' }],
    };

    it('matches the text, or the text of a copy sent without its files', () => {
        assert.ok(rendersAs(copy(contentHash(payload.content)), payload));
        const noted =
            'hi\n*Attachments not copied: f.png*\n*Originally posted 2024-03-01 18:22 UTC*';
        assert.ok(rendersAs(copy(contentHash(noted)), payload));
        assert.ok(!rendersAs(copy(contentHash('other')), payload));
        assert.ok(!rendersAs(copy(null), payload));
    });
});

describe('mention work budget', () => {
    it('gives the backfill one page and fix-ups two copies while the import is busy', () => {
        const busy = budgetFor(true, () => 0);
        assert.ok(busy.takePage());
        assert.ok(!busy.takePage());
        assert.ok(busy.takeCopy() && busy.takeCopy());
        assert.ok(!busy.takeCopy());
        const idle = budgetFor(false, () => 0);
        let pages = 0;
        while (idle.takePage() && pages < 1_000) pages += 1;
        assert.ok(pages > 1);
    });

    it('runs the backfill and fix-ups for each writable link, starting fix-ups once', async () => {
        const w = await world();
        await w.copy('11', { recorded: null });
        state(w).linked();
        let ensured = 0;
        const mentions = {
            ensureFixups: async (
                ...args: Parameters<FakeMentionStore['ensureFixups']>
            ) => {
                ensured += 1;
                return w.mentions.ensureFixups(...args);
            },
        };
        const work = new MentionWork({
            mentions,
            backfill: w.newBackfill(),
            fixups: w.fixups,
            listGuildLinks: async () => [{ id: LINK }],
            mode: async () => 'apply',
            now: () => w.state.clock,
            logger: w.logger,
        });
        await work.run(false, w.held);
        assert.equal(ensured, 1);
        assert.deepEqual(w.store.mentions.get('11'), [USER]);
        // Due only after the fidelity cache expired.
        assert.deepEqual(w.ports.edits, []);
        w.state.clock += FIXUP_DELAY_MS;
        await work.run(false, w.held);
        assert.equal(ensured, 1);
        assert.deepEqual(w.edited(), ['edit import-f10 copy-11']);
    });
});

type World = Awaited<ReturnType<typeof world>>;

/** Marks USER linked without starting a fix-up, as before a restart. */
function state(w: World) {
    return {
        linked: () => {
            w.state.rendered.add(USER);
            w.mentions.linked.set(USER, LINKED_AT);
        },
    };
}

/** The fix-up deps of a world, to build a variant. */
function depsOf(w: World) {
    return {
        mentions: w.mentions,
        store: w.store,
        ports: w.ports,
        formatter: new CopyFormatter({
            store: w.store,
            ports: w.ports,
            commandPrefix: '!b ',
        }),
        editor: new HistoryEditor(w.store, new FakeLinker(), w.ports),
        mode: async () => w.state.mode,
        report: async () => {},
        pause: async () => {},
        now: () => new Date(w.state.clock),
        logger: w.logger,
    };
}

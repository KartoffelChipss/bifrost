import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { messageRowKey } from '../../src/fluxer-db/keys';
import { chunks, copyName } from '../../src/name-sync/names';
import type { CopyRef, DueAuthor } from '../../src/name-sync/store';
import {
    AUTHORS_PER_PASS,
    MAX_LIVE_UPDATES,
    NameSync,
    liveCopies,
} from '../../src/name-sync/sync';
import { FluxerNameWriter, NAME_BATCH } from '../../src/name-sync/writer';
import { createRecordingLogger } from '../addons/fakes';

const NOW = new Date('2026-11-27T12:00:00Z');
const EPOCH = BigInt(1_420_070_400_000);

/** A snowflake for a time, as Discord and Fluxer both build them. */
function idAt(when: Date): string {
    return ((BigInt(when.getTime()) - EPOCH) << BigInt(22)).toString();
}

function copy(messageId: string, token: string | null = 't'): CopyRef {
    return {
        channelId: '100',
        messageId,
        webhookId: token ? '7' : null,
        webhookToken: token,
    };
}

describe('copy names', () => {
    it('picks the nickname, then the global name, then the username', () => {
        const base = { nick: null, globalName: null, username: 'jake' };
        assert.equal(
            copyName({ ...base, nick: 'Jake', globalName: 'J' }),
            'Jake'
        );
        assert.equal(copyName({ ...base, globalName: 'J' }), 'J');
        assert.equal(copyName(base), 'jake');
    });

    it('falls back to the username when Fluxer would refuse the name', () => {
        assert.equal(
            copyName({
                nick: 'x'.repeat(81),
                globalName: null,
                username: 'jake',
            }),
            'jake'
        );
        assert.equal(
            copyName({ nick: '   ', globalName: null, username: 'jake' }),
            'jake'
        );
    });

    it('splits work into bounded chunks', () => {
        assert.deepEqual(chunks([1, 2, 3], 2), [[1, 2], [3]]);
        assert.throws(() => chunks([1], 0), RangeError);
    });
});

describe('live updates', () => {
    it('takes only recent copies with a webhook token, newest first', () => {
        const old = copy(idAt(new Date('2026-11-01T00:00:00Z')));
        const noToken = copy(idAt(new Date('2026-11-27T11:00:00Z')), null);
        const a = copy(idAt(new Date('2026-11-26T00:00:00Z')));
        const b = copy(idAt(new Date('2026-11-27T10:00:00Z')));
        assert.deepEqual(liveCopies([old, noToken, a, b], NOW), [b, a]);
    });

    it('caps them', () => {
        const many = Array.from({ length: MAX_LIVE_UPDATES + 5 }, (_, i) =>
            copy(idAt(new Date(NOW.getTime() - i * 60_000)))
        );
        assert.equal(liveCopies(many, NOW).length, MAX_LIVE_UPDATES);
    });
});

describe('FluxerNameWriter', () => {
    it('sends row keys in batches and adds up the counts', async () => {
        const calls: unknown[][] = [];
        const writer = new FluxerNameWriter({
            rows: async <T extends object>(
                _sql: string,
                bind: readonly unknown[]
            ) => {
                calls.push([...bind]);
                return [
                    { changed: (bind[0] as string[]).length },
                ] as unknown as T[];
            },
        });
        const copies = Array.from({ length: NAME_BATCH + 1 }, (_, i) =>
            copy(String(1000 + i))
        );
        assert.equal(await writer.rename(copies, 'Jake'), NAME_BATCH + 1);
        assert.equal(calls.length, 2);
        assert.equal(
            (calls[0]?.[0] as string[])[0],
            messageRowKey('100', '1000')
        );
        assert.equal(calls[0]?.[1], 'Jake');
    });

    it('refuses a reply without a count', async () => {
        const writer = new FluxerNameWriter({
            rows: async <T extends object>() => [] as T[],
        });
        await assert.rejects(writer.rename([copy('1')], 'Jake'));
    });
});

function harness(fields: {
    optedOut?: boolean;
    names?: boolean;
    due?: number;
}) {
    const applied: [string, string | null][] = [];
    const failed: string[] = [];
    const renamed: [number, string][] = [];
    const refreshed: string[] = [];
    const recent = copy(idAt(new Date('2026-11-27T11:00:00Z')));
    const sync = new NameSync({
        store: {
            due: async (_guild, limit) =>
                Array.from(
                    { length: Math.min(fields.due ?? 1, limit) },
                    (_, i): DueAuthor => ({
                        discordUserId: `50${i}`,
                        appliedName: null,
                    })
                ),
            applied: async (_guild, user, name) => {
                applied.push([user, name]);
            },
            failed: async (_guild, user) => {
                failed.push(user);
            },
            isOptedOut: async () => fields.optedOut === true,
            copies: async () => [copy('1'), recent],
        },
        writer: {
            rename: async (copies, name) => {
                renamed.push([copies.length, name]);
                return copies.length;
            },
        },
        ports: {
            names: async () =>
                fields.names === false
                    ? null
                    : { nick: 'Jake', globalName: null, username: 'jake' },
            refresh: async (c) => {
                refreshed.push(c.messageId);
            },
        },
        logger: createRecordingLogger(),
        now: () => NOW,
    });
    return { sync, applied, failed, renamed, refreshed, recent };
}

const LINK = { id: 'link-1', discordGuildId: '1' };

describe('NameSync', () => {
    it('renames every copy, refreshes recent ones and records the name', async () => {
        const h = harness({});
        assert.equal(await h.sync.pass(LINK), false);
        assert.deepEqual(h.renamed, [[2, 'Jake']]);
        assert.deepEqual(h.refreshed, [h.recent.messageId]);
        assert.deepEqual(h.applied, [['500', 'Jake']]);
    });

    it('leaves an opted-out author as "Member"', async () => {
        const h = harness({ optedOut: true });
        await h.sync.pass(LINK);
        assert.deepEqual(h.renamed, []);
        assert.deepEqual(h.applied, [['500', null]]);
    });

    it('counts a failure when Discord has no such user', async () => {
        const h = harness({ names: false });
        await h.sync.pass(LINK);
        assert.deepEqual(h.failed, ['500']);
        assert.deepEqual(h.applied, []);
    });

    it('reports more work when more authors are due', async () => {
        const h = harness({ due: AUTHORS_PER_PASS + 3 });
        assert.equal(await h.sync.pass(LINK), true);
        assert.equal(h.applied.length, AUTHORS_PER_PASS);
    });
});

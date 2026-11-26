import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { downloadImage } from '../../src/guild-sync/assets';
import type { ApplyResult } from '../../src/guild-sync/apply';
import {
    NoticeBoard,
    applyAlert,
    failureFingerprint,
    planAlert,
    planFingerprint,
} from '../../src/guild-sync/notices';
import type { PlanOp } from '../../src/guild-sync/ops';
import { EMPTY_BODY, type Plan } from '../../src/guild-sync/plan';
import { createRecordingLogger } from '../addons/fakes';

const plan = (overrides: Partial<Plan> = {}): Plan => ({
    id: 'plan-1',
    guildLinkId: 'link-1',
    direction: 'discord-to-fluxer',
    status: 'dry-run',
    body: EMPTY_BODY,
    abortReason: null,
    ...overrides,
});

const createRole = (sourceId: string): PlanOp => ({
    op: 'create',
    kind: 'role',
    sourceId,
    name: sourceId,
    existingDestId: null,
});

const result = (overrides: Partial<ApplyResult> = {}): ApplyResult => ({
    applied: 3,
    failed: 0,
    skipped: [],
    failures: [],
    postponed: 0,
    stopped: null,
    ...overrides,
});

function recordingBoard() {
    const sent: string[] = [];
    const board = new NoticeBoard(async (_channel, text) => {
        sent.push(text);
    }, createRecordingLogger());
    return { board, sent };
}

describe('NoticeBoard', () => {
    it('posts a notice once while its key stays the same', async () => {
        const { board, sent } = recordingBoard();
        await board.post('link', 'plan', 'chan', 'k1', 'first');
        await board.post('link', 'plan', 'chan', 'k1', 'first again');
        await board.post('link', 'plan', 'chan', 'k2', 'second');
        await board.post('link', 'plan', null, 'k3', 'no channel set');
        assert.deepEqual(sent, ['first', 'second']);
    });

    it('keeps a last key per category, so categories cannot undo each other', async () => {
        const { board, sent } = recordingBoard();
        // The old board kept one key per link: alternating keys reposted.
        for (let cycle = 0; cycle < 3; cycle++) {
            await board.post('link', 'approval', 'chan', 'plan-a', 'approve');
            await board.post('link', 'abort', 'chan', 'abort-a', 'aborted');
        }
        assert.deepEqual(sent, ['approve', 'aborted']);
    });

    it('keeps the same category apart per link', async () => {
        const { board, sent } = recordingBoard();
        await board.post('a', 'approval', 'chan', 'k', 'for a');
        await board.post('b', 'approval', 'chan', 'k', 'for b');
        assert.deepEqual(sent, ['for a', 'for b']);
    });

    it('logs a failed post and does not throw', async () => {
        const logger = createRecordingLogger();
        const board = new NoticeBoard(async () => {
            throw new Error('missing access');
        }, logger);
        await board.post('link', 'plan', 'chan', 'k1', 'text');
        assert.match(logger.entries[0]?.message ?? '', /missing access/);
    });
});

describe('planAlert', () => {
    it('stays quiet for routine plans, even ones with work to do', () => {
        assert.equal(planAlert(plan(), '!b '), null);
        const busy = plan({
            body: {
                ...EMPTY_BODY,
                ops: [createRole('r1')],
                deferred: [createRole('r2')],
            },
        });
        assert.equal(planAlert(busy, '!b '), null);
    });

    it('tells the admin how to approve a pending plan', () => {
        const pending = plan({
            status: 'pending-approval',
            body: { ...EMPTY_BODY, needsApproval: true, approvalReason: 'x' },
        });
        const alert = planAlert(pending, '!b ');
        assert.equal(alert?.category, 'approval');
        assert.match(alert?.text ?? '', /`!b sync approve plan-1`/);
        assert.match(alert?.text ?? '', /`!b sync reject plan-1`/);
    });

    it('reports an aborted plan', () => {
        const aborted = plan({ status: 'aborted', abortReason: 'source 503' });
        const alert = planAlert(aborted, '!b ');
        assert.equal(alert?.category, 'abort');
        assert.match(alert?.text ?? '', /source 503/);
    });

    it('gives two plans with the same content the same fingerprint', () => {
        assert.equal(
            planFingerprint(plan({ id: 'a' })),
            planFingerprint(plan({ id: 'b' }))
        );
        assert.notEqual(
            planFingerprint(plan()),
            planFingerprint(plan({ abortReason: 'source error' }))
        );
    });
});

describe('applyAlert', () => {
    it('stays quiet for a clean apply', () => {
        assert.equal(applyAlert(plan(), result()), null);
        assert.equal(
            applyAlert(
                plan(),
                result({ skipped: [{ op: createRole('r'), reason: 'held' }] })
            ),
            null
        );
    });

    it('reports failures and an early stop', () => {
        const failed = result({
            failed: 1,
            failures: [{ op: createRole('r1'), reason: 'HTTP 403' }],
            stopped: 'the leader lock was lost',
        });
        const alert = applyAlert(plan(), failed);
        assert.equal(alert?.category, 'apply-failed');
        assert.match(alert?.text ?? '', /create role r1 failed: HTTP 403/);
        assert.match(alert?.text ?? '', /Stopped early: the leader lock/);
        const stoppedOnly = applyAlert(plan(), result({ stopped: 'kill' }));
        assert.equal(stoppedOnly?.category, 'apply-failed');
    });

    it('fingerprints the failing ops and reasons, not counts or retry times', () => {
        const fail = (sourceId: string, reason: string) =>
            result({
                failed: 1,
                failures: [{ op: createRole(sourceId), reason }],
            });
        assert.equal(
            failureFingerprint(fail('r1', 'rate limited, retry in 3 s')),
            failureFingerprint(fail('r1', 'rate limited, retry in 9 s'))
        );
        assert.notEqual(
            failureFingerprint(fail('r1', 'HTTP 403')),
            failureFingerprint(fail('r2', 'HTTP 403'))
        );
        assert.notEqual(
            failureFingerprint(fail('r1', 'missing access')),
            failureFingerprint(fail('r1', 'unknown role'))
        );
    });
});

describe('downloadImage', () => {
    const response = (type: string, size: number, ok = true) => ({
        ok,
        status: ok ? 200 : 404,
        headers: { get: () => type },
        arrayBuffer: async () => new ArrayBuffer(size),
    });
    const fetchOf = (r: ReturnType<typeof response>) => async () => r;
    const URL_OK = 'https://cdn.discordapp.com/emojis/1.png';

    it('returns a data URI for an image from the Discord CDN', async () => {
        const uri = await downloadImage(
            URL_OK,
            fetchOf(response('image/png', 3))
        );
        assert.equal(uri, 'data:image/png;base64,AAAA');
    });

    it('refuses other hosts, other types, big files and failed requests', async () => {
        const ok = fetchOf(response('image/png', 3));
        await assert.rejects(
            downloadImage('https://example.com/a.png', ok),
            /refusing/
        );
        await assert.rejects(
            downloadImage('http://cdn.discordapp.com/a.png', ok),
            /refusing/
        );
        await assert.rejects(
            downloadImage(URL_OK, fetchOf(response('text/html', 3))),
            /unexpected type/
        );
        await assert.rejects(
            downloadImage(URL_OK, fetchOf(response('image/png', 9)), 8),
            /limit 8/
        );
        await assert.rejects(
            downloadImage(URL_OK, fetchOf(response('image/png', 3, false))),
            /HTTP 404/
        );
    });
});

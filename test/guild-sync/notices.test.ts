import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { downloadImage } from '../../src/guild-sync/assets';
import {
    NoticeBoard,
    planFingerprint,
    planNotice,
} from '../../src/guild-sync/notices';
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

describe('NoticeBoard', () => {
    it('posts a notice once while its key stays the same', async () => {
        const sent: string[] = [];
        const board = new NoticeBoard(async (_channel, text) => {
            sent.push(text);
        }, createRecordingLogger());
        await board.post('link', 'chan', 'k1', 'first');
        await board.post('link', 'chan', 'k1', 'first again');
        await board.post('link', 'chan', 'k2', 'second');
        await board.post('link', null, 'k3', 'no channel set');
        assert.deepEqual(sent, ['first', 'second']);
    });

    it('logs a failed post and does not throw', async () => {
        const logger = createRecordingLogger();
        const board = new NoticeBoard(async () => {
            throw new Error('missing access');
        }, logger);
        await board.post('link', 'chan', 'k1', 'text');
        assert.match(logger.entries[0]?.message ?? '', /missing access/);
    });
});

describe('planNotice', () => {
    it('stays quiet for a plan with nothing to do', () => {
        assert.equal(planNotice(plan(), '!b '), null);
    });

    it('tells the admin how to approve a pending plan', () => {
        const pending = plan({
            status: 'pending-approval',
            body: { ...EMPTY_BODY, needsApproval: true, approvalReason: 'x' },
        });
        assert.match(
            planNotice(pending, '!b ') ?? '',
            /`!b sync approve plan-1`/
        );
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

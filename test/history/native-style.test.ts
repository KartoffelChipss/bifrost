import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CopyFormatter, withNote } from '../../src/history/format';
import type { SourceMessage } from '../../src/history/types';
import { FakeHistoryPorts, FakeHistoryStore } from './fakes';

function source(fields: Partial<SourceMessage> = {}): SourceMessage {
    return {
        id: '900',
        authorId: '500',
        createdAt: new Date('2019-05-01T10:20:00Z'),
        copyable: true,
        attachments: 0,
        webhookId: null,
        ownWebhook: false,
        reply: { authorId: '501' },
        reactions: [{ name: '👍', count: 3 }],
        raw: { text: 'hello' },
        ...fields,
    };
}

function formatter() {
    const ports = new FakeHistoryPorts();
    const store = new FakeHistoryStore();
    return {
        ports,
        build: new CopyFormatter({ store, ports, commandPrefix: '!b ' }),
    };
}

describe('copy style', () => {
    it('keeps the reactions and date lines on an imported copy', async () => {
        const { build } = formatter();
        const payload = await build.build(source(), 'link-1');
        assert.equal(
            payload.content,
            'hello\nReactions: 👍 3\n*Originally posted 2019-05-01 10:20 UTC*'
        );
    });

    it('leaves both lines off a native copy', async () => {
        const { build } = formatter();
        const payload = await build.build(source(), 'link-1', { native: true });
        assert.equal(payload.content, 'hello');
    });

    it('leaves the quote off a native reply only', async () => {
        const { build, ports } = formatter();
        await build.build(source(), 'link-1', { native: true });
        await build.build(source(), 'link-1', {
            native: true,
            nativeReply: true,
        });
        assert.deepEqual(
            ports.payloadOptions.map((o) => o.withoutReply),
            [false, true]
        );
    });

    it('puts a note last on a native copy, above the date on another', () => {
        assert.equal(withNote('a\nb', '*note*', true), 'a\nb\n*note*');
        assert.equal(withNote('a\n*date*', '*note*'), 'a\n*note*\n*date*');
    });
});

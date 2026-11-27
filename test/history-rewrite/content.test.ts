import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isReplyQuote,
    nativeContent,
    withoutReplyQuote,
} from '../../src/history-rewrite/content';

const AT = new Date('2019-05-01T10:20:00Z');
const DATE = '*Originally posted 2019-05-01 10:20 UTC*';

describe('nativeContent', () => {
    it('removes the reactions line and the date note', () => {
        assert.equal(
            nativeContent(`hello\nReactions: 👍 3 · :pog: 1\n${DATE}`, AT),
            'hello'
        );
        assert.equal(nativeContent(`hello\n${DATE}`, AT), 'hello');
        assert.equal(nativeContent(DATE, AT), '');
    });

    it('keeps the files note and the edit marker', () => {
        assert.equal(
            nativeContent(
                `hi\nReactions: 👍 3\n*Attachments not copied: a.png*\n${DATE}\n*Edited by its author*`,
                AT
            ),
            'hi\n*Attachments not copied: a.png*\n*Edited by its author*'
        );
    });

    it('keeps a body line that only looks like a reactions line', () => {
        assert.equal(
            nativeContent(`Reactions: please\n${DATE}`, AT),
            'Reactions: please'
        );
    });

    it('refuses a copy without the matching date note', () => {
        assert.equal(nativeContent('hello', AT), null);
        assert.equal(
            nativeContent(
                'hello\n*Originally posted 2019-05-01 10:21 UTC*',
                AT
            ),
            null
        );
        assert.equal(nativeContent(`${DATE}\na\nb\nc\nd`, AT), null);
    });
});

describe('reply quotes', () => {
    const quote = { color: 0x0b0d0e, author: { name: 'jake ↩️' } };
    const forward = {
        color: 0x0b0d0e,
        author: { name: 'Forwarded message ⏩' },
    };

    it('knows the reply quote bifrost adds', () => {
        assert.equal(isReplyQuote(quote), true);
        assert.equal(isReplyQuote(forward), false);
        assert.equal(
            isReplyQuote({ color: 1, author: { name: 'x ↩️' } }),
            false
        );
        assert.equal(isReplyQuote(null), false);
    });

    it('drops it only when it is first', () => {
        const rich = { title: 'link' };
        assert.deepEqual(withoutReplyQuote([quote, rich]), [rich]);
        assert.deepEqual(withoutReplyQuote([rich, quote]), [rich, quote]);
        assert.deepEqual(withoutReplyQuote([]), []);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isContentEdit, RECENT_EDIT_MS } from '../../src/relay-extras/edits';

const NOW = 10 * RECENT_EDIT_MS;

describe('isContentEdit', () => {
    it('is false for a message that was never edited (pin, preview)', () => {
        const next = { content: 'hi', editedTimestamp: null };
        assert.equal(isContentEdit({ content: 'hi' }, next, NOW), false);
        assert.equal(isContentEdit(null, { editedAt: null }, NOW), false);
    });

    it('compares text and edited time with the cached old message', () => {
        const old = { content: 'hi', editedTimestamp: 5 };
        assert.equal(
            isContentEdit(old, { content: 'hi', editedTimestamp: 5 }, NOW),
            false
        );
        assert.equal(
            isContentEdit(old, { content: 'hey', editedTimestamp: 5 }, NOW),
            true
        );
        assert.equal(
            isContentEdit(old, { content: 'hi', editedTimestamp: 6 }, NOW),
            true
        );
    });

    it('reads Fluxer edited dates', () => {
        const old = { content: 'a', editedAt: new Date(5) };
        assert.equal(
            isContentEdit(old, { content: 'a', editedAt: new Date(5) }, NOW),
            false
        );
        assert.equal(
            isContentEdit(old, { content: 'a', editedAt: new Date(6) }, NOW),
            true
        );
    });

    it('without the old message, counts only a recent edited time', () => {
        const recent = { content: 'x', editedTimestamp: NOW - 1_000 };
        const longAgo = { content: 'x', editedTimestamp: 0 };
        assert.equal(isContentEdit(null, recent, NOW), true);
        assert.equal(isContentEdit({ partial: true }, longAgo, NOW), false);
    });
});

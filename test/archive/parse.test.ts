import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    filesOf,
    memberFromUser,
    parseRawMember,
    parseRawMessage,
} from '../../src/archive/parse';
import { attachment, rawMessage } from './fakes';

describe('parseRawMessage', () => {
    it('keeps the API object and the fields the archive uses', () => {
        const raw = rawMessage('10', { webhook_id: '55', extra: { x: 1 } });
        const message = parseRawMessage(raw);
        assert.ok(message);
        assert.equal(message.id, '10');
        assert.equal(message.author.global_name, 'Alice');
        assert.equal(message.webhook_id, '55');
        assert.equal(message.json, raw);
    });

    it('refuses a message without an ID, author or valid time', () => {
        assert.equal(parseRawMessage(rawMessage('x')), null);
        assert.equal(parseRawMessage(rawMessage('10', { author: null })), null);
        assert.equal(
            parseRawMessage(rawMessage('10', { timestamp: 'soon' })),
            null
        );
        assert.equal(parseRawMessage(null), null);
        assert.equal(parseRawMessage([]), null);
    });

    it('drops attachments without an https URL', () => {
        const bad = { ...attachment('20'), url: 'http://evil/x' };
        const message = parseRawMessage(
            rawMessage('10', { attachments: [attachment('21'), bad] })
        );
        assert.deepEqual(
            message?.attachments.map((a) => a.id),
            ['21']
        );
    });
});

describe('filesOf', () => {
    it('lists attachments and sticker images with their URLs', () => {
        const message = parseRawMessage(
            rawMessage('10', {
                attachments: [attachment('21')],
                sticker_items: [
                    { id: '31', name: 'wave', format_type: 1 },
                    { id: '32', name: 'dance', format_type: 4 },
                ],
            })
        );
        assert.ok(message);
        assert.deepEqual(
            filesOf(message).map((f) => [f.kind, f.sourceId, f.url]),
            [
                ['attachment', '21', attachment('21').url],
                ['sticker', '31', 'https://cdn.discordapp.com/stickers/31.png'],
                ['sticker', '32', 'https://cdn.discordapp.com/stickers/32.gif'],
            ]
        );
    });
});

describe('member snapshots', () => {
    it('reads nickname and server avatar from a member', () => {
        const member = parseRawMember('100', {
            nick: 'Jake',
            avatar: 's1',
            user: {
                id: '300',
                username: 'ravenstryker',
                global_name: 'RavenStryker',
                avatar: 'a1',
            },
        });
        assert.deepEqual(member, {
            guildId: '100',
            userId: '300',
            username: 'ravenstryker',
            globalName: 'RavenStryker',
            nick: 'Jake',
            avatar: 'a1',
            serverAvatar: 's1',
            inGuild: true,
        });
    });

    it('keeps the user alone for someone who left', () => {
        const left = memberFromUser('100', {
            id: '300',
            username: 'bob',
            global_name: null,
            avatar: null,
        });
        assert.equal(left.inGuild, false);
        assert.equal(left.nick, null);
    });
});

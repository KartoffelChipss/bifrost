import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channel, discordGuild } from './fixtures';
import { opCount, setup } from './harness';

const mediaGuild = () =>
    discordGuild({
        channels: [
            channel('101'),
            channel('media', {
                type: 16,
                name: 'gallery',
                tags: ['art', 'photo'],
                defaultAutoArchive: 4320,
                forum: {
                    defaultReaction: { emojiId: null, emojiName: '🔥' },
                    sortOrder: 0,
                    layout: null,
                    tags: [
                        {
                            name: 'art',
                            moderated: false,
                            emojiId: null,
                            emojiName: null,
                        },
                        {
                            name: 'photo',
                            moderated: true,
                            emojiId: null,
                            emojiName: null,
                        },
                    ],
                },
            }),
        ],
        threads: [
            {
                id: 'm1',
                parentId: 'media',
                name: 'Sunset',
                archived: false,
                locked: false,
                tags: ['photo'],
            },
        ],
    });

describe('media channels', () => {
    it('syncs like forums: tags, defaults, link and posts', async () => {
        const s = setup(mediaGuild());
        s.useLinks();
        for (let i = 0; i < 4; i++) await s.cycle();
        const copy = s.guild.snapshot.channels.find(
            (c) => c.name === 'gallery'
        );
        assert.equal(copy?.type, 16);
        assert.deepEqual(copy?.tags, ['art', 'photo']);
        assert.equal(copy?.defaultAutoArchive, 4320);
        assert.ok(s.linker.links.some((l) => l.discordChannelId === 'media'));
        const post = s.guild.posts.find((p) => p.name === 'Sunset');
        assert.equal(post?.parentType, 16);
        assert.equal(post?.starter?.content, 'first message of m1');
        assert.equal(post?.webhook?.id, `fw-${copy?.id}`);
        assert.deepEqual(post?.tags, ['photo']);
        const settled = await s.cycle();
        assert.equal(opCount(settled.plan), 0);
    });
});

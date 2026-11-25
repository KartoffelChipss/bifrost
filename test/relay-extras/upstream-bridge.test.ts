import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    UpstreamBridge,
    type UpstreamServices,
} from '../../src/guild-sync/upstreamBridge';
import type { RelayLookupPorts } from '../../src/relay-extras/types';

const MESSAGE_LINK = {
    id: 'ml',
    guildLinkId: 'gl',
    channelLinkId: 'cl',
    discordMessageId: 'd-msg',
    fluxerMessageId: 'f-msg',
};

function bridge(
    channelLink: object | null = {
        discordChannelId: 'dc',
        fluxerChannelId: 'fc',
    }
) {
    const linkService = {
        getMessageLinkByDiscordMessageId: async (id: string) =>
            id === 'd-msg' ? MESSAGE_LINK : null,
        getMessageLinkByFluxerMessageId: async (id: string) =>
            id === 'f-msg' ? MESSAGE_LINK : null,
        getChannelLinkById: async () => channelLink,
        getGuildLinkById: async (id: string) =>
            id === 'gl' ? { discordGuildId: 'dg', fluxerGuildId: 'fg' } : null,
    };
    const emojis = (guild: string) => [
        { id: `${guild}-1`, name: 'party', animated: null },
        { id: `${guild}-2`, name: null, animated: false },
    ];
    const services = {
        linkService,
        discordEntityResolver: { fetchEmojis: async (g: string) => emojis(g) },
        fluxerEntityResolver: { fetchEmojis: async (g: string) => emojis(g) },
    } as unknown as UpstreamServices;
    // Typed as the port, so the bridge is checked to fit it.
    const ports: RelayLookupPorts = new UpstreamBridge(services);
    return ports;
}

describe('UpstreamBridge ReactionPorts', () => {
    it('finds a bridged message pair by either message ID', async () => {
        const expected = {
            guildLinkId: 'gl',
            discord: { channelId: 'dc', messageId: 'd-msg' },
            fluxer: { channelId: 'fc', messageId: 'f-msg' },
        };
        assert.deepEqual(
            await bridge().bridgedMessage('discord', 'd-msg'),
            expected
        );
        assert.deepEqual(
            await bridge().bridgedMessage('fluxer', 'f-msg'),
            expected
        );
    });

    it('returns null without a message or channel link', async () => {
        assert.equal(await bridge().bridgedMessage('discord', 'nope'), null);
        assert.equal(
            await bridge(null).bridgedMessage('discord', 'd-msg'),
            null
        );
    });

    it("finds a custom emoji on the side's server", async () => {
        assert.deepEqual(await bridge().guildEmoji('fluxer', 'gl', 'fg-1'), {
            id: 'fg-1',
            name: 'party',
            animated: false,
        });
        assert.equal(await bridge().guildEmoji('discord', 'gl', 'fg-1'), null);
        assert.equal(await bridge().guildEmoji('discord', 'gl', 'dg-2'), null);
        assert.equal(
            await bridge().guildEmoji('discord', 'nope', 'dg-1'),
            null
        );
    });
});

/** A Discord message with just what upstream's transformer reads. */
function discordMessage(content: string) {
    return {
        content,
        client: {
            users: { cache: new Map() },
            channels: { cache: new Map() },
        },
        guild: null,
        attachments: [],
        stickers: [],
        poll: null,
        embeds: [],
        reference: null,
        author: { username: 'alice', avatarURL: () => null },
    };
}

describe('UpstreamBridge Fluxer copies', () => {
    function withPrefix(commandPrefix: string) {
        const services = {
            linkService: { getGuildLinkById: async () => null },
            commandPrefix,
        } as unknown as UpstreamServices;
        return new UpstreamBridge(services);
    }

    it('defuses a leading command prefix so Fluxer never runs it', async () => {
        const payload = await withPrefix('!b ').payload(
            discordMessage('!b unlink'),
            'gl'
        );
        assert.equal(payload.content, '​!b unlink');
    });

    it('leaves other content alone', async () => {
        const payload = await withPrefix('!b ').payload(
            discordMessage('hello !b unlink'),
            'gl'
        );
        assert.equal(payload.content, 'hello !b unlink');
    });
});

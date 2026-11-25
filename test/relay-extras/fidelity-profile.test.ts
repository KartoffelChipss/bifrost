import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { installFidelity } from '../../src/relay-extras/fidelity';
import { webhookName } from '../../src/relay-extras/fidelity/profile';
import { FidelityService } from '../../src/relay-extras/fidelity/service';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import { discordMessage, FakePorts, fluxerMessage } from './fidelity-fakes';

afterEach(() => installFidelity(null));

function install() {
    installFidelity(new FidelityService(new FakePorts()));
}

function member(displayName: string, avatar: string | null) {
    return { displayName, avatarURL: () => avatar };
}

describe('webhookName', () => {
    it('uses a trimmed display name', () => {
        assert.equal(webhookName('  Ally  ', 'fluxer'), 'Ally');
    });

    it('keeps upstream when the name is missing, blank or too long', () => {
        assert.equal(webhookName(null, 'fluxer'), null);
        assert.equal(webhookName('   ', 'fluxer'), null);
        assert.equal(webhookName('x'.repeat(81), 'fluxer'), null);
        assert.equal(webhookName('x'.repeat(80), 'fluxer'), 'x'.repeat(80));
    });

    it('keeps upstream for a name Discord refuses', () => {
        assert.equal(webhookName('Discord fan', 'discord'), null);
        assert.equal(webhookName('clyde', 'discord'), null);
        assert.equal(webhookName('Discord fan', 'fluxer'), 'Discord fan');
    });
});

describe('fidelity names and avatars, Discord to Fluxer', () => {
    const transformer = new DiscordMessageTransformer();

    it('keeps upstream username and avatar when not installed', async () => {
        const out = await transformer.transformMessage(
            discordMessage({ member: member('Ally', 'https://cdn/server.png') })
        );
        assert.equal(out.username, 'alice');
        assert.equal(out.avatarURL, 'https://cdn/global.png');
    });

    it('uses the server nickname and server avatar', async () => {
        install();
        const out = await transformer.transformMessage(
            discordMessage({ member: member('Ally', 'https://cdn/server.png') })
        );
        assert.equal(out.username, 'Ally');
        assert.equal(out.avatarURL, 'https://cdn/server.png');
    });

    it('falls back to the global name and avatar', async () => {
        install();
        const out = await transformer.transformMessage(
            discordMessage({
                author: {
                    id: '101',
                    username: 'alice',
                    globalName: 'Alice A.',
                    avatarURL: () => 'https://cdn/global.png',
                },
            })
        );
        assert.equal(out.username, 'Alice A.');
        assert.equal(out.avatarURL, 'https://cdn/global.png');
    });
});

describe('fidelity names and avatars, Fluxer to Discord', () => {
    const transformer = new FluxerMessageTransformer();

    it('uses the Fluxer nickname and server avatar', async () => {
        install();
        const out = await transformer.transformMessage(
            fluxerMessage({ member: member('Ally', 'https://flx/server.webp') })
        );
        assert.equal(out.username, 'Ally');
        assert.equal(out.avatarURL, 'https://flx/server.webp');
    });

    it('keeps the username when Discord would refuse the nickname', async () => {
        install();
        const out = await transformer.transformMessage(
            fluxerMessage({ member: member('discord refugee', null) })
        );
        assert.equal(out.username, 'alice');
        assert.equal(out.avatarURL, 'https://cdn/global.png');
    });
});

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { installFidelity } from '../../src/relay-extras/fidelity';
import {
    discordSendFields,
    fluxerEditFields,
    fluxerSendFields,
} from '../../src/relay-extras/fidelity/send';
import { FidelityService } from '../../src/relay-extras/fidelity/service';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import { discordMessage, FakePorts, fluxerMessage } from './fidelity-fakes';

function install(ports = new FakePorts()) {
    installFidelity(new FidelityService(ports));
    return ports;
}

afterEach(() => installFidelity(null));

/** The pings of a copy fidelity could not resolve: none. */
const QUIET = { everyone: false, users: [], roles: [], repliedUser: false };

describe('fidelity mentions, Discord to Fluxer', () => {
    const transformer = new DiscordMessageTransformer();

    it('keeps upstream flat text when fidelity is not installed', async () => {
        const out = await transformer.transformMessage(
            discordMessage({ content: '<@101> <@&111> <#121>' })
        );
        assert.equal(out.content, '@alice @Mods #unknown-channel');
        assert.deepEqual(out.fidelity, { pings: QUIET });
    });

    it('maps linked users, synced roles, channels and threads', async () => {
        install();
        const out = await transformer.transformMessage(
            discordMessage({
                content: '<@101> <@&111> <#121> <#122>',
            })
        );
        assert.equal(out.content, '<@201> <@&211> <#221> <#222>');
    });

    it('falls back to upstream text for what does not map', async () => {
        install();
        const out = await transformer.transformMessage(
            discordMessage({ content: '<@102> <@&112>' })
        );
        assert.equal(out.content, '@bob @Mods');
    });

    it('maps a channel through upstream channel links', async () => {
        const ports = install();
        const out = await transformer.transformMessage(
            discordMessage({ content: 'see <#123>' })
        );
        assert.equal(out.content, 'see <#223>');
        assert.ok(ports.calls.includes('channel discord:123'));
    });

    it('maps a synced custom emoji by ID', async () => {
        install();
        const out = await transformer.transformMessage(
            discordMessage({ content: '<:wave:131>' }),
            [{ id: '231', name: 'wave', animated: false }]
        );
        assert.equal(out.content, '<:wave:231>');
    });

    it('relays with upstream formatting when a lookup fails', async () => {
        const ports = new FakePorts();
        ports.failObjectMap = new Error('db down');
        install(ports);
        const out = await transformer.transformMessage(
            discordMessage({ content: '<@101>' })
        );
        assert.equal(out.content, '@alice');
        assert.equal(ports.warnings.length, 1);
        await transformer.transformMessage(discordMessage());
        assert.equal(ports.warnings.length, 1, 'warnings are throttled');
    });

    it('leaves a message from an unlinked server alone', async () => {
        install();
        const out = await transformer.transformMessage(
            discordMessage({ guildId: 'elsewhere', content: '<@101>' })
        );
        assert.equal(out.content, '@alice');
        assert.deepEqual(out.fidelity, { pings: QUIET });
    });

    it('caches the maps between messages', async () => {
        const ports = install();
        await transformer.transformMessage(discordMessage());
        await transformer.transformMessage(discordMessage());
        const loads = ports.calls.filter((c) => c.startsWith('map '));
        assert.equal(loads.length, 1);
    });
});

describe('fidelity mentions, Fluxer to Discord', () => {
    const transformer = new FluxerMessageTransformer();

    it('keeps upstream broken text when fidelity is not installed', async () => {
        const out = await transformer.transformMessage(
            fluxerMessage({ content: '<@201> @everyone' })
        );
        assert.equal(out.content, '@​alice @​everyone');
    });

    it('maps mentions and keeps them whole', async () => {
        install();
        const out = await transformer.transformMessage(
            fluxerMessage({
                content: '<@201> <@&211> <#222> @everyone',
            })
        );
        assert.equal(out.content, '<@101> <@&111> <#122> @​everyone');
    });
});

describe('fidelity webhook fields', () => {
    const pings = {
        everyone: false,
        users: ['u'],
        roles: ['r'],
        repliedUser: true,
    };

    it('sends nothing extra for a payload without fork fields', () => {
        assert.deepEqual(fluxerSendFields(undefined), {});
        assert.deepEqual(fluxerEditFields(undefined), {});
        assert.deepEqual(discordSendFields(undefined), {});
    });

    it('gives Fluxer explicit lists, or everyone alone', () => {
        assert.deepEqual(fluxerSendFields({ pings }).allowedMentions, {
            parse: [],
            users: ['u'],
            roles: ['r'],
            repliedUser: true,
        });
        assert.deepEqual(
            fluxerSendFields({ pings: { ...pings, everyone: true } })
                .allowedMentions,
            { parse: ['everyone'], repliedUser: true }
        );
        assert.deepEqual(fluxerEditFields({ pings }), {
            allowed_mentions: {
                parse: [],
                users: ['u'],
                roles: ['r'],
                replied_user: true,
            },
        });
    });

    it('gives Discord everyone with the lists', () => {
        assert.deepEqual(
            discordSendFields({ pings: { ...pings, everyone: true } }),
            {
                allowedMentions: {
                    parse: ['everyone'],
                    users: ['u'],
                    roles: ['r'],
                    repliedUser: true,
                },
            }
        );
    });
});

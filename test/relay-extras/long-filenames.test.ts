import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { installFidelity } from '../../src/relay-extras/fidelity';
import { FLUXER_MAX_FILENAME_LENGTH } from '../../src/services/fluxerFiles';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import { discordMessage } from './fidelity-fakes';

afterEach(() => installFidelity(null));

describe('Discord attachments relayed to Fluxer', () => {
    it('shortens a filename Fluxer would refuse, keeping its extension', async () => {
        const long = `${'screenshot_'.repeat(30)}.png`;
        const message = discordMessage({
            attachments: [
                { url: 'https://cdn/a', name: long, spoiler: false, size: 10 },
                {
                    url: 'https://cdn/b',
                    name: 'cat.gif',
                    spoiler: false,
                    size: 10,
                },
            ],
        });
        const out = await new DiscordMessageTransformer().transformMessage(
            message
        );
        const names = (out.attachments ?? []).map((a) => a.name);
        assert.equal(names[0]?.length, FLUXER_MAX_FILENAME_LENGTH);
        assert.ok(names[0]?.endsWith('.png'));
        assert.equal(names[1], 'cat.gif');
    });

    it('names an attachment that has no name', async () => {
        const message = discordMessage({
            attachments: [
                { url: 'https://cdn/a', name: '', spoiler: false, size: 10 },
            ],
        });
        const out = await new DiscordMessageTransformer().transformMessage(
            message
        );
        assert.equal(out.attachments?.[0]?.name, 'attachment');
    });
});

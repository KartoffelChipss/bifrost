import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message as FluxerMessage } from '@fluxerjs/core';
import type { MapRow } from '../../src/guild-sync/ops';
import type { MessagePair } from '../../src/relay-extras/types';
import type {
    AccountPair,
    ChannelLinkRef,
    FidelityPorts,
    GuildLinkRef,
    Side,
} from '../../src/relay-extras/fidelity/types';
import type DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';

export const LINK: GuildLinkRef = {
    id: 'link-1',
    discordGuildId: 'd-guild',
    fluxerGuildId: 'f-guild',
};

export function row(
    kind: MapRow['kind'],
    discordId: string,
    fluxerId: string,
    state: MapRow['state'] = 'active'
): MapRow {
    return {
        id: `${kind}-${discordId}`,
        kind,
        discordId,
        fluxerId,
        state,
        createdBySync: true,
        missingSince: null,
        missingCount: 0,
        destMissingCount: 0,
        destMissingSince: null,
        appliedFields: null,
    };
}

export const ROWS: MapRow[] = [
    row('role', '111', '211'),
    row('channel', '121', '221'),
    row('thread', '122', '222'),
    row('emoji', '131', '231'),
    row('sticker', '141', '241'),
    row('role', '112', '212', 'archived'),
];

export const ACCOUNTS: AccountPair[] = [
    { discordUserId: '101', fluxerUserId: '201' },
];

/** Ports over fixed data; counts calls so tests can check the caches. */
export class FakePorts implements FidelityPorts {
    calls: string[] = [];
    warnings: string[] = [];
    clock = 1_000;
    rows: MapRow[] = ROWS;
    accounts: AccountPair[] = ACCOUNTS;
    channelLinks = new Map<string, ChannelLinkRef>([
        [
            'discord:123',
            {
                guildLinkId: LINK.id,
                discordChannelId: '123',
                fluxerChannelId: '223',
            },
        ],
        [
            'fluxer:223',
            {
                guildLinkId: LINK.id,
                discordChannelId: '123',
                fluxerChannelId: '223',
            },
        ],
    ]);
    pairs: MessagePair[] = [];
    failObjectMap: Error | null = null;
    /** Sticker IDs each server has. */
    stickers = new Map<string, Set<string>>([
        [LINK.fluxerGuildId, new Set(['241'])],
    ]);

    async guildStickerIds(side: Side, guildId: string) {
        this.calls.push(`stickers ${side}:${guildId}`);
        return this.stickers.get(guildId) ?? new Set<string>();
    }

    /** Target message IDs that were deleted. */
    gone = new Set<string>();
    failExists: Error | null = null;

    async messageExists(side: Side, channelId: string, messageId: string) {
        this.calls.push(`exists ${side}:${channelId}/${messageId}`);
        if (this.failExists) throw this.failExists;
        return !this.gone.has(messageId);
    }

    readonly logger = {
        info: () => undefined,
        warn: (message: string) => {
            this.warnings.push(message);
        },
        error: () => undefined,
    };

    now = () => this.clock;

    async listGuildLinks() {
        this.calls.push('links');
        return [LINK];
    }

    async loadObjectMap(id: string) {
        this.calls.push(`map ${id}`);
        if (this.failObjectMap) throw this.failObjectMap;
        return this.rows;
    }

    async listAccountPairs() {
        this.calls.push('accounts');
        return this.accounts;
    }

    async channelLink(side: Side, id: string) {
        this.calls.push(`channel ${side}:${id}`);
        return this.channelLinks.get(`${side}:${id}`) ?? null;
    }

    findPair = async (side: Side, messageId: string) => {
        this.calls.push(`pair ${side}:${messageId}`);
        return this.pairs.find((p) => p[side].messageId === messageId) ?? null;
    };
}

type DiscordMessage = Parameters<
    DiscordMessageTransformer['transformMessage']
>[0];

/** A Discord message with what upstream's transformer and fidelity read. */
export function discordMessage(fields: Record<string, unknown> = {}) {
    const names = new Map([
        ['101', 'alice'],
        ['102', 'bob'],
    ]);
    const message = {
        id: 'd-msg',
        guildId: LINK.discordGuildId,
        channelId: '121',
        content: '',
        client: {
            users: {
                cache: {
                    get: (id: string) =>
                        names.has(id) ? { username: names.get(id) } : undefined,
                },
            },
            channels: { cache: { get: () => undefined } },
        },
        guild: { roles: { cache: { get: () => ({ name: 'Mods' }) } } },
        author: {
            id: '101',
            username: 'alice',
            globalName: null,
            avatarURL: () => 'https://cdn/global.png',
        },
        member: null,
        attachments: [],
        stickers: [],
        embeds: [],
        poll: null,
        reference: null,
        mentions: {
            users: new Map(),
            roles: new Map(),
            everyone: false,
            repliedUser: null,
        },
        ...fields,
    };
    return message as unknown as DiscordMessage;
}

/** A Fluxer message with what upstream's transformer and fidelity read. */
export function fluxerMessage(fields: Record<string, unknown> = {}) {
    const names = new Map([['201', 'alice']]);
    const message = {
        id: 'f-msg',
        guildId: LINK.fluxerGuildId,
        channelId: '221',
        content: '',
        client: {
            users: {
                get: (id: string) =>
                    names.has(id) ? { username: names.get(id) } : undefined,
            },
            channels: { get: () => undefined },
        },
        guild: { roles: { get: () => ({ name: 'Mods' }) } },
        author: {
            id: '201',
            username: 'alice',
            globalName: null,
            avatarURL: () => 'https://cdn/global.png',
        },
        member: null,
        attachments: [],
        stickers: [],
        embeds: [],
        referencedMessage: null,
        messageReference: null,
        mentions: [],
        mentionRoles: [],
        mentionEveryone: false,
        ...fields,
    };
    return message as unknown as FluxerMessage;
}

/**
 * Upstream's WebhookService, loaded after the environment its logger
 * reads: placeholder tokens and a throwaway log folder.
 */
export async function loadWebhookService() {
    process.env.BF_FLUXER_TOKEN ??= 'test-token';
    process.env.BF_DISCORD_TOKEN ??= 'test-token';
    process.env.BF_CONFIG_PATH ??= mkdtempSync(join(tmpdir(), 'bifrost-'));
    const module = await import('../../src/services/WebhookService');
    const Base = module.WebhookService;
    // Every service a test makes downloads files with fakeFetchFile.
    const withFakeFiles = function (this: unknown) {
        return new Base(fakeFetchFile);
    } as unknown as typeof Base;
    withFakeFiles.prototype = Base.prototype;
    return withFakeFiles;
}

/** A file download that returns the URL itself, so tests can read it back. */
export async function fakeFetchFile(url: string): Promise<ArrayBuffer> {
    const bytes = new TextEncoder().encode(url);
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    );
}

/** The URLs of files fakeFetchFile downloaded, from their data. */
export function fetchedUrls(files: unknown): string[] {
    return (files as { data: ArrayBuffer }[]).map((f) =>
        new TextDecoder().decode(f.data)
    );
}

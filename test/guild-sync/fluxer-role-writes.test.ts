import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ThreadChannel, type Client } from '@fluxerjs/core';
import { findListed } from '../../src/guild-sync/readers/fluxer';
import {
    FluxerGuildWriter,
    needsReopen,
    roleUpdateBody,
} from '../../src/guild-sync/writers/fluxer';

interface Call {
    readonly method: string;
    readonly route: string;
    readonly options: unknown;
}

/**
 * A ready Fluxer client whose guild records REST calls. fetchRole throws
 * the way it does against Fluxer, which has no route to read one role.
 */
function recordingClient(calls: Call[]) {
    const record =
        (method: string) =>
        async (route: string, options?: unknown): Promise<unknown> => {
            calls.push({ method, route, options });
            return undefined;
        };
    const rest = {
        get: record('get'),
        patch: record('patch'),
        delete: record('delete'),
    };
    const roles = new Map<string, unknown>([['r1', {}]]);
    const guild = {
        id: 'g1',
        client: { rest },
        roles,
        fetchRole: async () => {
            throw new Error('Role r1 not found in guild');
        },
        fetchEmoji: async () => {
            throw new Error('Emoji e1 not found in guild');
        },
        fetchSticker: async () => {
            throw new Error('Sticker s1 not found in guild');
        },
        // As the library does: it reads roles from Fluxer's empty 204 body.
        setRolePositions: async () => {
            const data: unknown = undefined;
            return (data as unknown[]).map((r) => r);
        },
    };
    const client = {
        isReady: () => true,
        guilds: { fetch: async () => guild },
    } as unknown as Client;
    return { client, roles };
}

describe('Fluxer role writes', () => {
    it('updates a role with one PATCH, without reading it first', async () => {
        const calls: Call[] = [];
        const { client } = recordingClient(calls);
        const writer = new FluxerGuildWriter({ current: client });
        await writer.updateRole('g1', 'r1', {
            name: 'Mods',
            permissions: '8',
            unicodeEmoji: null,
        });
        assert.deepEqual(calls, [
            {
                method: 'patch',
                route: '/guilds/g1/roles/r1',
                options: {
                    body: {
                        name: 'Mods',
                        permissions: '8',
                        unicode_emoji: null,
                    },
                    auth: true,
                },
            },
        ]);
    });

    it('sends nothing for an empty patch', async () => {
        const calls: Call[] = [];
        const { client } = recordingClient(calls);
        await new FluxerGuildWriter({ current: client }).updateRole(
            'g1',
            'r1',
            {}
        );
        assert.deepEqual(calls, []);
    });

    it('deletes a role without reading it first', async () => {
        const calls: Call[] = [];
        const { client, roles } = recordingClient(calls);
        await new FluxerGuildWriter({ current: client }).deleteRole('g1', 'r1');
        assert.deepEqual(
            calls.map((c) => `${c.method} ${c.route}`),
            ['delete /guilds/g1/roles/r1']
        );
        assert.equal(roles.has('r1'), false);
    });

    it('maps every role field to the body Fluxer takes', () => {
        assert.deepEqual(
            roleUpdateBody({
                name: 'a',
                color: 1,
                hoist: true,
                mentionable: false,
                permissions: '0',
                icon: 'data:image/png;base64,AAAA',
            }),
            {
                name: 'a',
                color: 1,
                hoist: true,
                mentionable: false,
                permissions: '0',
                icon: 'data:image/png;base64,AAAA',
            }
        );
    });
});

describe('Fluxer lookup by list', () => {
    const list = async () => [{ id: 'r1' }, { id: 'r2' }];

    it('finds an object in the full list', async () => {
        assert.deepEqual(await findListed('r2', list), { id: 'r2' });
    });

    it('reports an object missing from the list as a 404', async () => {
        await assert.rejects(findListed('gone', list), { statusCode: 404 });
    });
});

describe('Fluxer writes without a single-object read', () => {
    it('reorders roles with one PATCH and ignores the empty 204 body', async () => {
        const calls: Call[] = [];
        const { client } = recordingClient(calls);
        await new FluxerGuildWriter({ current: client }).setRolePositions(
            'g1',
            [{ id: 'r1', position: 2 }]
        );
        assert.deepEqual(calls, [
            {
                method: 'patch',
                route: '/guilds/g1/roles',
                options: { body: [{ id: 'r1', position: 2 }], auth: true },
            },
        ]);
    });

    it('renames and deletes emojis and deletes stickers by ID', async () => {
        const calls: Call[] = [];
        const { client } = recordingClient(calls);
        const writer = new FluxerGuildWriter({ current: client });
        await writer.renameEmoji('g1', 'e1', 'wave');
        await writer.deleteEmoji('g1', 'e1');
        await writer.deleteSticker('g1', 's1');
        assert.deepEqual(
            calls.map((c) => `${c.method} ${c.route}`),
            [
                'patch /guilds/g1/emojis/e1',
                'delete /guilds/g1/emojis/e1',
                'delete /guilds/g1/stickers/s1',
            ]
        );
        assert.deepEqual(calls[0].options, {
            body: { name: 'wave' },
            auth: true,
        });
    });
});

describe('Fluxer edits of archived threads', () => {
    it('needs a reopen only to change more than archived on an archived thread', () => {
        assert.equal(needsReopen(true, { locked: false }), true);
        assert.equal(
            needsReopen(true, { name: 'x', archived: undefined }),
            true
        );
        assert.equal(
            needsReopen(true, { archived: false, locked: true }),
            false
        );
        assert.equal(needsReopen(true, { archived: true }), false);
        assert.equal(needsReopen(false, { locked: true }), false);
    });

    it('unarchives in the same edit and archives again after', async () => {
        const edits: Record<string, unknown>[] = [];
        const thread = Object.assign(Object.create(ThreadChannel.prototype), {
            archived: true,
            flags: 0,
            parentId: null,
            edit: async (options: Record<string, unknown>) => {
                edits.push(options);
                return thread;
            },
        });
        const channels = { fetch: async () => thread };
        const client = {
            isReady: () => true,
            guilds: { fetch: async () => ({ id: 'g1', client: { channels } }) },
            channels,
        } as unknown as Client;
        await new FluxerGuildWriter({ current: client }).updateThread(
            'g1',
            't1',
            { locked: true }
        );
        assert.deepEqual(edits, [
            { locked: true, archived: false },
            { archived: true },
        ]);
    });
});

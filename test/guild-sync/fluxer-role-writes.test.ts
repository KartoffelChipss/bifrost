import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@fluxerjs/core';
import { fetchRoleFromList } from '../../src/guild-sync/readers/fluxer';
import {
    FluxerGuildWriter,
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
            return {};
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

describe('Fluxer role lookup', () => {
    const guild = {
        fetchRoles: async () => [{ id: 'r1' }, { id: 'r2' }],
    } as unknown as Parameters<typeof fetchRoleFromList>[0];

    it('finds a role in the full list', async () => {
        assert.deepEqual(await fetchRoleFromList(guild, 'r2'), { id: 'r2' });
    });

    it('reports a role missing from the list as a 404', async () => {
        await assert.rejects(fetchRoleFromList(guild, 'gone'), {
            statusCode: 404,
        });
    });
});

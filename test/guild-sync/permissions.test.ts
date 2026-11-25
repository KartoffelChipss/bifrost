import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlags } from '@fluxerjs/util';
import { PermissionFlagsBits } from 'discord.js';
import {
    DISCORD_ONLY_BITS,
    FLUXER_ONLY_BITS,
    MANAGED_BITS,
    PERMISSION_TABLE,
    THREAD_BITS,
    bitOf,
    mergePermissions,
    translatePermissions,
} from '../../src/guild-sync/permissions';

const discordFlags: Record<string, bigint> = PermissionFlagsBits;
/** Deprecated discord.js names for a bit the table already lists. */
const DISCORD_ALIASES: Record<string, string> = {
    ManageEmojisAndStickers: 'ManageGuildExpressions',
};
const fluxerFlags: Record<string, bigint> = PermissionFlags;

describe('permission table', () => {
    it('gives every row the same bit in discord.js and @fluxerjs/util', () => {
        for (const [discordName, fluxerName, bit] of PERMISSION_TABLE) {
            assert.equal(discordFlags[discordName], bitOf(bit), discordName);
            assert.equal(fluxerFlags[fluxerName], bitOf(bit), fluxerName);
        }
    });

    it('accounts for every discord.js flag', () => {
        const known = new Set<string>([
            ...PERMISSION_TABLE.map(([name]) => name),
            ...Object.keys(DISCORD_ONLY_BITS),
            ...Object.keys(THREAD_BITS),
        ]);
        for (const [alias, name] of Object.entries(DISCORD_ALIASES)) {
            assert.equal(discordFlags[alias], discordFlags[name], alias);
            known.add(alias);
        }
        for (const name of Object.keys(discordFlags)) {
            assert.ok(known.has(name), `${name} is missing from the table`);
        }
        for (const [name, bit] of Object.entries(DISCORD_ONLY_BITS)) {
            assert.equal(discordFlags[name], bitOf(bit), name);
            assert.ok(!Object.values(fluxerFlags).includes(bitOf(bit)), name);
        }
    });

    it('keeps thread permissions apart until @fluxerjs/util lists them', () => {
        for (const [name, bit] of Object.entries(THREAD_BITS)) {
            assert.equal(discordFlags[name], bitOf(bit), name);
            assert.equal(MANAGED_BITS & bitOf(bit), bitOf(bit), name);
            // When the library adds the flag, move the row into the table.
            assert.equal(fluxerFlags[name], undefined, name);
        }
    });

    it('accounts for every @fluxerjs/util flag', () => {
        const known = new Set<string>([
            ...PERMISSION_TABLE.map(([, name]) => name),
            ...Object.keys(FLUXER_ONLY_BITS),
        ]);
        for (const name of Object.keys(fluxerFlags)) {
            assert.ok(known.has(name), `${name} is missing from the table`);
        }
        for (const [name, bit] of Object.entries(FLUXER_ONLY_BITS)) {
            assert.equal(fluxerFlags[name], bitOf(bit), name);
        }
    });
});

describe('translatePermissions', () => {
    it('keeps shared bits and reports Discord-only ones', () => {
        const source =
            PermissionFlagsBits.ViewChannel |
            PermissionFlagsBits.ManageThreads |
            PermissionFlagsBits.SendPolls;
        const result = translatePermissions(source, 'discord-to-fluxer');
        assert.equal(
            result.bits,
            PermissionFlags.ViewChannel | PermissionFlagsBits.ManageThreads
        );
        assert.deepEqual(result.dropped, ['SendPolls']);
    });

    it('reports Fluxer-only bits by name in the reverse direction', () => {
        const result = translatePermissions(
            PermissionFlags.UpdateRtcRegion,
            'fluxer-to-discord'
        );
        assert.equal(result.bits, BigInt(0));
        assert.deepEqual(result.dropped, ['UpdateRtcRegion']);
    });

    it('rejects a negative bitfield', () => {
        assert.throws(() =>
            translatePermissions(BigInt(-1), 'discord-to-fluxer')
        );
    });
});

describe('mergePermissions', () => {
    it('rewrites managed bits and preserves unmanaged destination bits', () => {
        const destination =
            PermissionFlags.UpdateRtcRegion | PermissionFlags.KickMembers;
        const merged = mergePermissions(
            destination,
            PermissionFlags.ViewChannel
        );
        assert.equal(
            merged,
            PermissionFlags.UpdateRtcRegion | PermissionFlags.ViewChannel
        );
        assert.equal(merged & ~MANAGED_BITS, PermissionFlags.UpdateRtcRegion);
    });
});

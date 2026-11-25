import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { D_GUILD, F_GUILD, channel, discordGuild, role } from './fixtures';
import { opCount, setup } from './harness';

const VIEW = PermissionFlagsBits.ViewChannel.toString();
/** SendMessages, AddReactions and SendMessagesInThreads. */
const LOCK = (
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.AddReactions |
    PermissionFlagsBits.SendMessagesInThreads
).toString();

const guild = () =>
    discordGuild({
        roles: [role(D_GUILD, { permissions: VIEW })],
        channels: [
            channel('text', { name: 'general' }),
            channel('forum', { type: 15, name: 'game-chat' }),
            channel('admin', { name: 'admin' }),
        ],
    });

function gated() {
    const s = setup(guild());
    s.store.settings = { ...s.store.settings, adminChannelId: 'admin' };
    s.useLinks();
    const ready = new Set<string>();
    s.historyReady(ready);
    const copy = (name: string) =>
        s.guild.snapshot.channels.find((c) => c.name === name);
    return { s, ready, copy };
}

const everyoneLock = [{ id: F_GUILD, type: 0, allow: '0', deny: LOCK }];

describe('posting lock while history imports', () => {
    it('creates a channel locked until its history is ready', async () => {
        const { s, copy } = gated();
        await s.cycle();
        assert.deepEqual(copy('general')?.overwrites, everyoneLock);
        assert.deepEqual(copy('game-chat')?.overwrites, []);
        assert.deepEqual(copy('admin')?.overwrites, []);
        const second = await s.cycle();
        assert.equal(
            second.plan.body.findings.filter((f) => f.type === 'drift').length,
            0
        );
    });

    it('locks an existing copy once history gating starts', async () => {
        const s = setup(guild());
        s.useLinks();
        await s.cycle();
        const general = () =>
            s.guild.snapshot.channels.find((c) => c.name === 'general');
        assert.deepEqual(general()?.overwrites, []);
        s.historyReady(new Set());
        await s.cycle();
        assert.deepEqual(general()?.overwrites, everyoneLock);
    });

    it('unlocks the copy once its history is ready', async () => {
        const { s, ready, copy } = gated();
        await s.cycle();
        ready.add('text');
        const unlock = await s.cycle();
        assert.ok(
            unlock.plan.body.ops.some(
                (op) => op.op === 'update' && op.kind === 'channel'
            )
        );
        assert.deepEqual(copy('general')?.overwrites, []);
        await s.cycle();
        const settled = await s.cycle();
        assert.equal(opCount(settled.plan), 0);
    });

    it('never locks a channel without history gating', async () => {
        const s = setup(guild());
        s.useLinks();
        await s.cycle();
        const general = s.guild.snapshot.channels.find(
            (c) => c.name === 'general'
        );
        assert.deepEqual(general?.overwrites, []);
    });
});

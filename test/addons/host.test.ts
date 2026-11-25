import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AddonConfig } from '../../src/addons/config';
import { AddonHost, selectAddons, type Addon } from '../../src/addons/host';
import { startAddons } from '../../src/addons/index';
import { IsolationBoundary } from '../../src/addons/isolation';
import { AddonModeController } from '../../src/addons/mode';
import { createRecordingLogger } from './fakes';

const ALL_ON: AddonConfig = {
    enabled: true,
    guildSync: true,
    history: true,
    identity: true,
    initialMode: 'dry-run',
    allowApply: false,
    excludedChannels: new Set(),
};

function fakeAddon(
    name: string,
    behaviour: Partial<Addon> = {}
): Addon & {
    calls: string[];
} {
    const calls: string[] = [];
    return {
        name,
        calls,
        start: behaviour.start ?? (async () => void calls.push('start')),
        stop: behaviour.stop ?? (async () => void calls.push('stop')),
    };
}

function context() {
    const mode = new AddonModeController('dry-run');
    const logger = createRecordingLogger();
    return {
        mode,
        logger,
        boundary: new IsolationBoundary(mode, logger),
        allowApply: false,
    };
}

describe('selectAddons', () => {
    it('returns implemented add-ons and lists the missing ones', () => {
        const { addons, missing } = selectAddons(ALL_ON, {
            guildSync: () => fakeAddon('guild-sync'),
        });
        assert.deepEqual(
            addons.map((addon) => addon.name),
            ['guild-sync']
        );
        assert.deepEqual(missing, ['history', 'identity']);
    });

    it('skips add-ons that are switched off', () => {
        const { addons, missing } = selectAddons(
            { ...ALL_ON, guildSync: false, history: false, identity: false },
            { guildSync: () => fakeAddon('guild-sync') }
        );
        assert.equal(addons.length, 0);
        assert.equal(missing.length, 0);
    });
});

describe('AddonHost', () => {
    it('rejects duplicate add-on names', () => {
        assert.throws(
            () => new AddonHost([fakeAddon('a'), fakeAddon('a')], context()),
            /unique/
        );
    });

    it('starts the others when one start fails, and trips read-only', async () => {
        const ctx = context();
        const good = fakeAddon('good');
        const bad = fakeAddon('bad', {
            start: async () => {
                throw new Error('boom');
            },
        });
        const host = new AddonHost([bad, good], ctx);
        const report = await host.startAll();
        assert.deepEqual(report, { started: ['good'], failed: ['bad'] });
        assert.equal(ctx.mode.mode, 'read-only');
    });

    it('stops started add-ons in reverse order, once', async () => {
        const order: string[] = [];
        const make = (name: string) =>
            fakeAddon(name, { stop: async () => void order.push(name) });
        const host = new AddonHost([make('a'), make('b')], context());
        await host.startAll();
        await host.stopAll();
        await host.stopAll();
        assert.deepEqual(order, ['b', 'a']);
    });

    it('gives up on a stop that hangs', async () => {
        const ctx = context();
        const hung = fakeAddon('hung', { stop: () => new Promise(() => {}) });
        const host = new AddonHost([hung], ctx, 20);
        await host.startAll();
        await host.stopAll();
        assert.equal(ctx.mode.mode, 'read-only');
    });
});

describe('startAddons', () => {
    it('does nothing when add-ons are disabled', async () => {
        const logger = createRecordingLogger();
        const factory = () => fakeAddon('guild-sync');
        const handle = await startAddons(
            { ...ALL_ON, enabled: false },
            logger,
            { guildSync: factory }
        );
        assert.equal(handle, null);
    });

    it('starts enabled add-ons and stops them through the handle', async () => {
        const logger = createRecordingLogger();
        const addon = fakeAddon('guild-sync');
        const handle = await startAddons(
            { ...ALL_ON, history: false, identity: false },
            logger,
            { guildSync: () => addon }
        );
        assert.ok(handle);
        await handle.stop();
        assert.deepEqual(addon.calls, ['start', 'stop']);
    });
});

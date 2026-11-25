import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { AddonConfig } from '../../src/addons/config';
import {
    AddonHost,
    DEFAULT_STOP_TIMEOUT_MS,
    selectAddons,
    type Addon,
} from '../../src/addons/host';
import { Sequelize } from 'sequelize';
import { initAddonDatabase, startAddons } from '../../src/addons/index';
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
    warnings: [],
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

    it('stops every add-on within one shared deadline', async () => {
        const ctx = context();
        const hang = () => new Promise<void>(() => {});
        const asked: string[] = [];
        const make = (name: string) =>
            fakeAddon(name, {
                stop: () => {
                    asked.push(name);
                    return hang();
                },
            });
        const host = new AddonHost([make('a'), make('b'), make('c')], ctx, 40);
        await host.startAll();
        const started = Date.now();
        await host.stopAll();
        const took = Date.now() - started;
        // Three hung add-ons share 40 ms instead of taking 40 ms each.
        assert.ok(took < 100, `took ${took} ms`);
        assert.deepEqual(asked, ['c', 'b', 'a']);
    });

    it('fits the default deadline inside Docker grace', () => {
        assert.ok(DEFAULT_STOP_TIMEOUT_MS < 10_000);
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

describe('startAddons after startup problems', () => {
    const sqlite = new Sequelize('sqlite::memory:', { logging: false });
    after(() => sqlite.close());

    it('logs config warnings while add-ons are off', async () => {
        const logger = createRecordingLogger();
        const handle = await startAddons(
            { ...ALL_ON, enabled: false, warnings: ['BF_ADDON_X is bad'] },
            logger,
            {}
        );
        assert.equal(handle, null);
        assert.ok(
            logger.entries.some(
                (e) => e.level === 'warn' && e.message.includes('BF_ADDON_X')
            )
        );
    });

    it('keeps add-ons off after a failed migration', async () => {
        const logger = createRecordingLogger();
        // SQLite makes the add-on migrations fail.
        const state = await initAddonDatabase(ALL_ON, sqlite, logger);
        assert.equal(state, 'failed');
        const addon = fakeAddon('guild-sync');
        const handle = await startAddons(ALL_ON, logger, {
            guildSync: () => addon,
        });
        assert.equal(handle, null);
        assert.deepEqual(addon.calls, []);
        assert.ok(
            logger.entries.some((e) => /migrations failed/.test(e.message))
        );
        // Reset the module state for other tests in this file.
        await initAddonDatabase({ ...ALL_ON, enabled: false }, sqlite, logger);
    });
});

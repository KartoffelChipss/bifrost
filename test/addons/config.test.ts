import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    AddonConfigError,
    parseAddonConfig,
    requireAddonConfig,
} from '../../src/addons/config';

describe('parseAddonConfig', () => {
    it('defaults to everything off in dry-run', () => {
        assert.deepEqual(parseAddonConfig({}), {
            ok: true,
            config: {
                enabled: false,
                guildSync: false,
                history: false,
                identity: false,
                initialMode: 'dry-run',
                allowApply: false,
                excludedChannels: new Set(),
            },
        });
    });

    it('keeps add-ons off when the master switch is off', () => {
        const result = parseAddonConfig({
            BF_ADDON_GUILD_SYNC: 'true',
            BF_ADDON_IDENTITY: 'true',
        });
        assert.ok(result.ok);
        assert.equal(result.config.guildSync, false);
        assert.equal(result.config.identity, false);
    });

    it('turns on only the add-ons that are switched on', () => {
        const result = parseAddonConfig({
            BF_ADDONS_ENABLED: 'yes',
            BF_DB_DIALECT: 'postgres',
            BF_ADDON_GUILD_SYNC: '1',
            BF_ADDON_HISTORY: 'false',
            BF_ADDONS_MODE: 'read-only',
        });
        assert.ok(result.ok);
        assert.equal(result.config.guildSync, true);
        assert.equal(result.config.history, false);
        assert.equal(result.config.identity, false);
        assert.equal(result.config.initialMode, 'read-only');
    });

    it('rejects an unknown boolean instead of reading it as false', () => {
        const result = parseAddonConfig({ BF_ADDONS_ENABLED: 'ture' });
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /BF_ADDONS_ENABLED/);
    });

    it('rejects apply mode from the environment', () => {
        const result = parseAddonConfig({ BF_ADDONS_MODE: 'apply' });
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /BF_ADDONS_ALLOW_APPLY/);
    });

    it('allows apply only with its own switch and add-ons on', () => {
        const on = parseAddonConfig({
            BF_ADDONS_ENABLED: 'true',
            BF_DB_DIALECT: 'postgres',
            BF_ADDONS_ALLOW_APPLY: 'true',
        });
        assert.equal(on.ok && on.config.allowApply, true);
        const addonsOff = parseAddonConfig({ BF_ADDONS_ALLOW_APPLY: 'true' });
        assert.equal(addonsOff.ok && addonsOff.config.allowApply, false);
        assert.equal(
            parseAddonConfig({ BF_ADDONS_ALLOW_APPLY: 'maybe' }).ok,
            false
        );
    });

    it('reads the excluded channel list and rejects a bad ID', () => {
        const result = parseAddonConfig({
            BF_ADDONS_EXCLUDE_CHANNELS:
                '126729786981744640, 452223817377382440',
        });
        assert.deepEqual(result.ok && [...result.config.excludedChannels], [
            '126729786981744640',
            '452223817377382440',
        ]);
        assert.equal(
            parseAddonConfig({ BF_ADDONS_EXCLUDE_CHANNELS: '#admins-only' }).ok,
            false
        );
    });

    it('rejects an unknown mode', () => {
        const result = parseAddonConfig({ BF_ADDONS_MODE: 'yolo' });
        assert.equal(result.ok, false);
    });
});

describe('parseAddonConfig database dialect', () => {
    it('refuses add-ons on the SQLite default', () => {
        const result = parseAddonConfig({ BF_ADDONS_ENABLED: 'true' });
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /BF_DB_DIALECT=postgres/);
    });

    it('refuses add-ons on an explicit SQLite dialect', () => {
        const result = parseAddonConfig({
            BF_ADDONS_ENABLED: 'true',
            BF_DB_DIALECT: 'sqlite',
        });
        assert.equal(result.ok, false);
    });

    it('allows SQLite while add-ons are off', () => {
        const result = parseAddonConfig({ BF_DB_DIALECT: 'sqlite' });
        assert.equal(result.ok, true);
    });

    it('accepts the exact value postgres', () => {
        const result = parseAddonConfig({
            BF_ADDONS_ENABLED: 'true',
            BF_DB_DIALECT: 'postgres',
        });
        assert.equal(result.ok, true);
    });

    it('refuses values upstream would not read as Postgres', () => {
        for (const value of ['Postgres', ' postgres', 'postgresql']) {
            const result = parseAddonConfig({
                BF_ADDONS_ENABLED: 'true',
                BF_DB_DIALECT: value,
            });
            assert.equal(result.ok, false, value);
        }
    });
});

describe('requireAddonConfig', () => {
    it('throws AddonConfigError on a bad value', () => {
        assert.throws(
            () => requireAddonConfig({ BF_ADDON_HISTORY: 'maybe' }),
            AddonConfigError
        );
    });
});

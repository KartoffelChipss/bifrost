import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    AddonConfigError,
    parseAddonConfig,
    requireAddonConfig,
} from '../../src/addons/config';

const ON = { BF_ADDONS_ENABLED: 'true', BF_DB_DIALECT: 'postgres' };

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
                warnings: [],
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
        const result = parseAddonConfig({ ...ON, BF_ADDONS_MODE: 'apply' });
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
            parseAddonConfig({ ...ON, BF_ADDONS_ALLOW_APPLY: 'maybe' }).ok,
            false
        );
    });

    it('reads the excluded channel list and rejects a bad ID', () => {
        const result = parseAddonConfig({
            ...ON,
            BF_ADDONS_EXCLUDE_CHANNELS:
                '126729786981744640, 452223817377382440',
        });
        assert.deepEqual(result.ok && [...result.config.excludedChannels], [
            '126729786981744640',
            '452223817377382440',
        ]);
        assert.equal(
            parseAddonConfig({
                ...ON,
                BF_ADDONS_EXCLUDE_CHANNELS: '#admins-only',
            }).ok,
            false
        );
    });

    it('rejects an unknown mode', () => {
        const result = parseAddonConfig({ ...ON, BF_ADDONS_MODE: 'yolo' });
        assert.equal(result.ok, false);
    });
});

describe('parseAddonConfig while add-ons are off', () => {
    const BAD = {
        BF_ADDON_HISTORY: 'maybe',
        BF_ADDONS_ALLOW_APPLY: 'sure',
        BF_ADDONS_MODE: 'apply',
        BF_ADDONS_EXCLUDE_CHANNELS: '#admins-only',
    };

    it('turns bad settings into warnings instead of errors', () => {
        const result = parseAddonConfig(BAD);
        assert.ok(result.ok);
        assert.equal(result.config.enabled, false);
        assert.equal(result.config.history, false);
        assert.equal(result.config.excludedChannels.size, 0);
        assert.equal(result.config.warnings.length, 4);
        for (const name of Object.keys(BAD)) {
            assert.ok(
                result.config.warnings.some((w) => w.includes(name)),
                name
            );
        }
        assert.ok(result.config.warnings.every((w) => w.includes('ignored')));
    });

    it('still fails fast on the same settings while add-ons are on', () => {
        const result = parseAddonConfig({ ...ON, ...BAD });
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /BF_ADDON_HISTORY/);
        assert.match(!result.ok ? result.error : '', /BF_ADDONS_MODE/);
    });

    it('fails fast on a bad master switch', () => {
        assert.equal(
            parseAddonConfig({ ...BAD, BF_ADDONS_ENABLED: 'maybe' }).ok,
            false
        );
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
    it('throws AddonConfigError on a bad value while add-ons are on', () => {
        assert.throws(
            () => requireAddonConfig({ ...ON, BF_ADDON_HISTORY: 'maybe' }),
            AddonConfigError
        );
    });

    it('does not throw on a bad sub-setting while add-ons are off', () => {
        const config = requireAddonConfig({ BF_ADDON_HISTORY: 'maybe' });
        assert.equal(config.enabled, false);
        assert.equal(config.warnings.length, 1);
    });
});

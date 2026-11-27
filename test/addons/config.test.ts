import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    AddonConfigError,
    parseAddonConfig,
    requireAddonConfig,
} from '../../src/addons/config';
import { SEND_INTERVAL_MS } from '../../src/history/limits';

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

    it('leaves archive-thread mode off unless a count is set', () => {
        const unset = parseAddonConfig(ON);
        assert.equal(unset.ok && unset.config.historyInlineMax, 0);
        const zero = parseAddonConfig({ ...ON, BF_HISTORY_INLINE_MAX: '0' });
        assert.equal(zero.ok && zero.config.historyInlineMax, 0);
        const set = parseAddonConfig({ ...ON, BF_HISTORY_INLINE_MAX: '10000' });
        assert.equal(set.ok && set.config.historyInlineMax, 10000);
        for (const bad of ['-1', '1e4', 'lots', '99999999999']) {
            assert.equal(
                parseAddonConfig({ ...ON, BF_HISTORY_INLINE_MAX: bad }).ok,
                false,
                bad
            );
        }
    });

    it('waits the default send interval unless one is set', () => {
        const unset = parseAddonConfig(ON);
        assert.equal(
            unset.ok && unset.config.historySendIntervalMs,
            SEND_INTERVAL_MS
        );
        const zero = parseAddonConfig({
            ...ON,
            BF_HISTORY_SEND_INTERVAL_MS: '0',
        });
        assert.equal(zero.ok && zero.config.historySendIntervalMs, 0);
        const set = parseAddonConfig({
            ...ON,
            BF_HISTORY_SEND_INTERVAL_MS: '200',
        });
        assert.equal(set.ok && set.config.historySendIntervalMs, 200);
        for (const bad of ['-1', '1.5', 'fast', '60001']) {
            assert.equal(
                parseAddonConfig({ ...ON, BF_HISTORY_SEND_INTERVAL_MS: bad })
                    .ok,
                false,
                bad
            );
        }
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

describe('parseAddonConfig BF_ADDONS_RESET_USER_ID', () => {
    const config = (env: Record<string, string>) => {
        const result = parseAddonConfig({ ...ON, ...env });
        assert.ok(result.ok);
        return result.config;
    };

    it('reads one Discord user ID', () => {
        const id = '200000000000000001';
        assert.equal(
            config({ BF_ADDONS_RESET_USER_ID: ` ${id} ` }).resetUserId,
            id
        );
    });

    it('leaves the reset off when unset or empty', () => {
        assert.equal(config({}).resetUserId, undefined);
        const empty = config({ BF_ADDONS_RESET_USER_ID: '' });
        assert.equal(empty.resetUserId, undefined);
        assert.deepEqual(empty.warnings, []);
    });

    it('warns and leaves the reset off for a malformed value', () => {
        for (const value of [
            'abc',
            '123',
            '200000000000000001,2000000000000002',
        ]) {
            const parsed = config({ BF_ADDONS_RESET_USER_ID: value });
            assert.equal(parsed.resetUserId, undefined, value);
            assert.equal(parsed.enabled, true);
            assert.match(parsed.warnings.join(), /BF_ADDONS_RESET_USER_ID/);
        }
        const off = parseAddonConfig({ BF_ADDONS_RESET_USER_ID: 'abc' });
        assert.ok(off.ok);
        assert.match(off.config.warnings.join(), /RESET_USER_ID.*ignored/);
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

describe('archive settings', () => {
    it('needs an absolute BF_ARCHIVE_DIR when the archive is on', () => {
        for (const dir of [undefined, '', 'archive']) {
            const result = parseAddonConfig({
                ...ON,
                BF_ADDON_ARCHIVE: 'true',
                BF_ARCHIVE_DIR: dir,
            });
            assert.equal(result.ok, false, String(dir));
            assert.match(!result.ok ? result.error : '', /BF_ARCHIVE_DIR/);
        }
    });

    it('reads the folder and the free-space reserve, defaulting to 20 GB', () => {
        const on = {
            ...ON,
            BF_ADDON_ARCHIVE: 'true',
            BF_ARCHIVE_DIR: '/data/archive',
        };
        const result = parseAddonConfig(on);
        assert.ok(result.ok);
        assert.equal(result.config.archive, true);
        assert.equal(result.config.archiveDir, '/data/archive');
        assert.equal(result.config.archiveMinFreeGb, 20);
        const custom = parseAddonConfig({
            ...on,
            BF_ARCHIVE_MIN_FREE_GB: '50',
        });
        assert.ok(custom.ok);
        assert.equal(custom.config.archiveMinFreeGb, 50);
    });

    it('rejects a reserve that is not a whole number', () => {
        for (const value of ['-1', '2.5', 'lots', '100001']) {
            const result = parseAddonConfig({
                ...ON,
                BF_ARCHIVE_MIN_FREE_GB: value,
            });
            assert.equal(result.ok, false, value);
        }
    });

    it('leaves the archive off by default without a folder', () => {
        const result = parseAddonConfig(ON);
        assert.ok(result.ok);
        assert.equal(result.config.archive, false);
        assert.equal(result.config.archiveDir, undefined);
    });
});

describe('name sync settings', () => {
    const on = {
        ...ON,
        BF_ADDON_NAME_SYNC: 'true',
        BF_FLUXER_DB_HOST: 'fluxer-postgres-1',
        BF_FLUXER_DB_PASS: 'secret',
    };

    it('needs the Fluxer database host and password', () => {
        for (const missing of ['BF_FLUXER_DB_HOST', 'BF_FLUXER_DB_PASS']) {
            const result = parseAddonConfig({ ...on, [missing]: '' });
            assert.equal(result.ok, false, missing);
            assert.match(!result.ok ? result.error : '', /BF_FLUXER_DB_HOST/);
        }
    });

    it('reads the connection, with defaults for port, database and role', () => {
        const result = parseAddonConfig(on);
        assert.ok(result.ok);
        assert.equal(result.config.nameSync, true);
        assert.deepEqual(result.config.fluxerDb, {
            host: 'fluxer-postgres-1',
            port: 5432,
            database: 'fluxer',
            user: 'bifrost_bridge',
            password: 'secret',
        });
    });

    it('refuses a bad port, and asks nothing while name sync is off', () => {
        const bad = parseAddonConfig({ ...on, BF_FLUXER_DB_PORT: '70000' });
        assert.equal(bad.ok, false);
        const off = parseAddonConfig(ON);
        assert.ok(off.ok);
        assert.equal(off.config.fluxerDb, undefined);
    });
});

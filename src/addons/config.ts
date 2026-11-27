/**
 * Add-on configuration, parsed from the environment once at startup.
 *
 * Everything defaults to off, so a fresh deploy of the fork behaves exactly
 * like upstream Bifröst. The apply mode is never accepted from the
 * environment: an admin switches it on per guild link (safety guard 9).
 * The environment only decides whether that switch is allowed at all.
 */

import type { FluxerDbSettings } from '../fluxer-db/pool';
import { SEND_INTERVAL_MS } from '../history/limits';

export type AddonMode = 'read-only' | 'dry-run' | 'apply';

export interface AddonConfig {
    readonly enabled: boolean;
    readonly guildSync: boolean;
    readonly history: boolean;
    readonly identity: boolean;
    /**
     * BF_ADDON_ARCHIVE: keeps a local copy of Discord messages, member
     * names and files (src/archive). Absent while add-ons are off.
     */
    readonly archive?: boolean;
    /** BF_ARCHIVE_DIR: the volume for archived files. Set when archive is on. */
    readonly archiveDir?: string;
    /**
     * BF_ARCHIVE_MIN_FREE_GB: file downloads pause while the volume has
     * less free space than this. Defaults to 20.
     */
    readonly archiveMinFreeGb?: number;
    /**
     * BF_ADDON_NAME_SYNC: puts each Discord member's current name on every
     * Fluxer copy of their messages (src/name-sync). Absent while add-ons
     * are off.
     */
    readonly nameSync?: boolean;
    /** BF_FLUXER_DB_*: Fluxer's database. Set when name sync is on. */
    readonly fluxerDb?: FluxerDbSettings;
    readonly initialMode: Exclude<AddonMode, 'apply'>;
    /** BF_ADDONS_ALLOW_APPLY. Without it, no add-on writes to a server. */
    readonly allowApply: boolean;
    /**
     * BF_ADDONS_EXCLUDE_CHANNELS: Discord channel or category IDs the
     * add-ons never copy, bridge or import. A category covers its channels.
     */
    readonly excludedChannels: ReadonlySet<string>;
    /**
     * BF_HISTORY_INLINE_MAX: channels with more messages than this get
     * their history in a Fluxer thread and are bridged at once. Unset or
     * 0 (the default) imports every channel inline.
     */
    readonly historyInlineMax?: number;
    /**
     * BF_HISTORY_SEND_INTERVAL_MS: the wait after each history copy, per
     * webhook. Unset: SEND_INTERVAL_MS, which keeps under Fluxer's webhook
     * rate limit. Lower it only while that limit is off.
     */
    readonly historySendIntervalMs?: number;
    /**
     * BF_ADDONS_RESET_USER_ID: the one Discord user who may run
     * `sync reset-threads`. Absent when unset or invalid, which turns the
     * command off; a bad value is only a warning.
     */
    readonly resetUserId?: string;
    /**
     * Problems found in add-on settings while add-ons are off. They do not
     * stop startup; the host logs them as warnings.
     */
    readonly warnings: readonly string[];
}

export type AddonConfigResult =
    | { readonly ok: true; readonly config: AddonConfig }
    | { readonly ok: false; readonly error: string };

type Env = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = ['true', '1', 'yes'];
const FALSE_VALUES = ['false', '0', 'no', ''];
const ENV_MODES = ['read-only', 'dry-run'] as const;

/** Parses a strict boolean. Unknown values are an error, never false. */
function parseStrictBool(
    name: string,
    value: string | undefined
): { ok: true; value: boolean } | { ok: false; error: string } {
    const normalized = (value ?? '').trim().toLowerCase();
    if (TRUE_VALUES.includes(normalized)) return { ok: true, value: true };
    if (FALSE_VALUES.includes(normalized)) return { ok: true, value: false };
    return {
        ok: false,
        error: `${name} must be one of ${[...TRUE_VALUES, ...FALSE_VALUES.filter(Boolean)].join(', ')}`,
    };
}

function parseMode(
    value: string | undefined
):
    | { ok: true; value: AddonConfig['initialMode'] }
    | { ok: false; error: string } {
    const normalized = (value ?? '').trim().toLowerCase();
    if (normalized === '') return { ok: true, value: 'dry-run' };
    if (normalized === 'apply') {
        return {
            ok: false,
            error: 'BF_ADDONS_MODE=apply is not accepted from the environment. Set BF_ADDONS_ALLOW_APPLY=true, then switch apply on per server with the sync command.',
        };
    }
    const mode = ENV_MODES.find((candidate) => candidate === normalized);
    if (!mode) {
        return {
            ok: false,
            error: `BF_ADDONS_MODE must be one of ${ENV_MODES.join(', ')}`,
        };
    }
    return { ok: true, value: mode };
}

const SNOWFLAKE = /^\d{15,25}$/;

/**
 * Parses BF_ADDONS_RESET_USER_ID. Unset or empty is null. A bad value is
 * a warning, never an error: it only leaves `sync reset-threads` off.
 */
function parseResetUser(value: string | undefined): {
    id: string | null;
    warning: string | null;
} {
    const text = (value ?? '').trim();
    if (text === '') return { id: null, warning: null };
    if (SNOWFLAKE.test(text)) return { id: text, warning: null };
    return {
        id: null,
        warning:
            'BF_ADDONS_RESET_USER_ID is not a Discord user ID; `sync reset-threads` stays off',
    };
}

/** Upper bound for BF_HISTORY_INLINE_MAX. */
const MAX_INLINE_MAX = 10_000_000;

/** Parses a message count: unset or empty is 0, meaning off. */
function parseCount(
    name: string,
    value: string | undefined
): { ok: true; value: number } | { ok: false; error: string } {
    const text = (value ?? '').trim();
    if (text === '') return { ok: true, value: 0 };
    const count = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(count) || count > MAX_INLINE_MAX) {
        return {
            ok: false,
            error: `${name} must be a whole number from 0 to ${MAX_INLINE_MAX}`,
        };
    }
    return { ok: true, value: count };
}

/** Upper bound for BF_HISTORY_SEND_INTERVAL_MS: one minute. */
const MAX_SEND_INTERVAL_MS = 60_000;

/** Parses BF_HISTORY_SEND_INTERVAL_MS: unset or empty is the default. */
function parseSendInterval(
    value: string | undefined
): { ok: true; value: number } | { ok: false; error: string } {
    const text = (value ?? '').trim();
    if (text === '') return { ok: true, value: SEND_INTERVAL_MS };
    const ms = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(ms) || ms > MAX_SEND_INTERVAL_MS) {
        return {
            ok: false,
            error: `BF_HISTORY_SEND_INTERVAL_MS must be a whole number from 0 to ${MAX_SEND_INTERVAL_MS}`,
        };
    }
    return { ok: true, value: ms };
}

/** Parses a comma- or space-separated list of Discord IDs. */
function parseIdList(
    name: string,
    value: string | undefined
): { ok: true; value: ReadonlySet<string> } | { ok: false; error: string } {
    const ids = (value ?? '').split(/[\s,]+/).filter((id) => id !== '');
    const bad = ids.find((id) => !SNOWFLAKE.test(id));
    if (bad !== undefined) {
        return {
            ok: false,
            error: `${name} has an invalid Discord ID: ${bad}`,
        };
    }
    return { ok: true, value: new Set(ids) };
}

const BOOL_KEYS = {
    guildSync: 'BF_ADDON_GUILD_SYNC',
    history: 'BF_ADDON_HISTORY',
    identity: 'BF_ADDON_IDENTITY',
    archive: 'BF_ADDON_ARCHIVE',
    nameSync: 'BF_ADDON_NAME_SYNC',
    allowApply: 'BF_ADDONS_ALLOW_APPLY',
} as const;

type Flags = Record<keyof typeof BOOL_KEYS, boolean>;

/** Every setting except the master switch. Collects each problem found. */
function parseSettings(env: Env): {
    flags: Flags;
    mode: AddonConfig['initialMode'];
    excluded: ReadonlySet<string>;
    inlineMax: number;
    sendIntervalMs: number;
    resetUser: ReturnType<typeof parseResetUser>;
    errors: string[];
} {
    const errors: string[] = [];
    const flags: Flags = {
        guildSync: false,
        history: false,
        identity: false,
        archive: false,
        nameSync: false,
        allowApply: false,
    };
    for (const [field, envName] of Object.entries(BOOL_KEYS)) {
        const parsed = parseStrictBool(envName, env[envName]);
        if (parsed.ok) flags[field as keyof Flags] = parsed.value;
        else errors.push(parsed.error);
    }
    const mode = parseMode(env.BF_ADDONS_MODE);
    if (!mode.ok) errors.push(mode.error);
    const excluded = parseIdList(
        'BF_ADDONS_EXCLUDE_CHANNELS',
        env.BF_ADDONS_EXCLUDE_CHANNELS
    );
    if (!excluded.ok) errors.push(excluded.error);
    const inlineMax = parseCount(
        'BF_HISTORY_INLINE_MAX',
        env.BF_HISTORY_INLINE_MAX
    );
    if (!inlineMax.ok) errors.push(inlineMax.error);
    const sendInterval = parseSendInterval(env.BF_HISTORY_SEND_INTERVAL_MS);
    if (!sendInterval.ok) errors.push(sendInterval.error);
    return {
        flags,
        mode: mode.ok ? mode.value : 'dry-run',
        excluded: excluded.ok ? excluded.value : new Set(),
        inlineMax: inlineMax.ok ? inlineMax.value : 0,
        sendIntervalMs: sendInterval.ok ? sendInterval.value : SEND_INTERVAL_MS,
        resetUser: parseResetUser(env.BF_ADDONS_RESET_USER_ID),
        errors,
    };
}

/** Default for BF_ARCHIVE_MIN_FREE_GB, and its upper bound. */
export const DEFAULT_ARCHIVE_MIN_FREE_GB = 20;
const MAX_ARCHIVE_MIN_FREE_GB = 100_000;

/**
 * Parses the archive's settings. BF_ARCHIVE_DIR is required, as an
 * absolute path, only while the archive is switched on.
 */
function parseArchive(
    env: Env,
    on: boolean
):
    | { ok: true; dir?: string; minFreeGb: number }
    | { ok: false; error: string } {
    const dir = (env.BF_ARCHIVE_DIR ?? '').trim();
    if (on && !dir.startsWith('/')) {
        return {
            ok: false,
            error: 'BF_ADDON_ARCHIVE needs BF_ARCHIVE_DIR set to an absolute path',
        };
    }
    const text = (env.BF_ARCHIVE_MIN_FREE_GB ?? '').trim();
    const gb = text === '' ? DEFAULT_ARCHIVE_MIN_FREE_GB : Number(text);
    if (
        !/^\d*$/.test(text) ||
        !Number.isSafeInteger(gb) ||
        gb > MAX_ARCHIVE_MIN_FREE_GB
    ) {
        return {
            ok: false,
            error: `BF_ARCHIVE_MIN_FREE_GB must be a whole number from 0 to ${MAX_ARCHIVE_MIN_FREE_GB}`,
        };
    }
    return { ok: true, ...(dir ? { dir } : {}), minFreeGb: gb };
}

const DEFAULT_FLUXER_DB_PORT = 5432;
const MAX_PORT = 65_535;

/**
 * Parses BF_FLUXER_DB_HOST, _PORT, _NAME, _USER and _PASS (or _PASS_FILE,
 * read by src/utils/env.ts). The host and password are required only while
 * name sync is on.
 */
function parseFluxerDb(
    env: Env,
    on: boolean
): { ok: true; value?: FluxerDbSettings } | { ok: false; error: string } {
    if (!on) return { ok: true };
    const host = (env.BF_FLUXER_DB_HOST ?? '').trim();
    const password = env.BF_FLUXER_DB_PASS ?? '';
    if (host === '' || password === '') {
        return {
            ok: false,
            error: 'BF_ADDON_NAME_SYNC needs BF_FLUXER_DB_HOST and BF_FLUXER_DB_PASS (or BF_FLUXER_DB_PASS_FILE)',
        };
    }
    const portText = (env.BF_FLUXER_DB_PORT ?? '').trim();
    const port = portText === '' ? DEFAULT_FLUXER_DB_PORT : Number(portText);
    if (
        !/^\d*$/.test(portText) ||
        !Number.isSafeInteger(port) ||
        port < 1 ||
        port > MAX_PORT
    ) {
        return {
            ok: false,
            error: `BF_FLUXER_DB_PORT must be a port from 1 to ${MAX_PORT}`,
        };
    }
    return {
        ok: true,
        value: {
            host,
            port,
            database: (env.BF_FLUXER_DB_NAME ?? '').trim() || 'fluxer',
            user: (env.BF_FLUXER_DB_USER ?? '').trim() || 'bifrost_bridge',
            password,
        },
    };
}

/** Add-ons off. Bad sub-settings become warnings, so the relay still starts. */
function disabledConfig(errors: readonly string[]): AddonConfig {
    return {
        enabled: false,
        guildSync: false,
        history: false,
        identity: false,
        initialMode: 'dry-run',
        allowApply: false,
        excludedChannels: new Set(),
        warnings: errors.map(
            (error) => `${error} (ignored: BF_ADDONS_ENABLED is off)`
        ),
    };
}

/**
 * Parses add-on settings from an environment map without side effects.
 * A bad BF_ADDONS_ENABLED is always an error. While add-ons are off, any
 * other bad setting is only a warning; while they are on, it is an error.
 */
export function parseAddonConfig(env: Env): AddonConfigResult {
    const enabled = parseStrictBool('BF_ADDONS_ENABLED', env.BF_ADDONS_ENABLED);
    if (!enabled.ok) return { ok: false, error: enabled.error };
    const settings = parseSettings(env);
    const resetWarnings = settings.resetUser.warning
        ? [settings.resetUser.warning]
        : [];
    if (!enabled.value) {
        const errors = [...settings.errors, ...resetWarnings];
        return { ok: true, config: disabledConfig(errors) };
    }
    const archive = parseArchive(env, settings.flags.archive);
    if (!archive.ok) settings.errors.push(archive.error);
    const fluxerDb = parseFluxerDb(env, settings.flags.nameSync);
    if (!fluxerDb.ok) settings.errors.push(fluxerDb.error);
    if (settings.errors.length > 0 || !archive.ok || !fluxerDb.ok)
        return { ok: false, error: settings.errors.join('; ') };

    // Read exactly as upstream does (src/utils/env.ts, src/db/sequelize.ts):
    // only the literal 'postgres' selects Postgres. The add-on tables use
    // JSONB and an advisory lock, so add-ons refuse to start without it.
    const dialect = env.BF_DB_DIALECT || 'sqlite';
    if (dialect !== 'postgres') {
        return {
            ok: false,
            error: `BF_ADDONS_ENABLED needs BF_DB_DIALECT=postgres, got ${dialect}`,
        };
    }
    const { flags, resetUser } = settings;
    return {
        ok: true,
        config: {
            enabled: true,
            ...flags,
            initialMode: settings.mode,
            excludedChannels: settings.excluded,
            historyInlineMax: settings.inlineMax,
            historySendIntervalMs: settings.sendIntervalMs,
            ...(archive.dir ? { archiveDir: archive.dir } : {}),
            archiveMinFreeGb: archive.minFreeGb,
            ...(fluxerDb.value ? { fluxerDb: fluxerDb.value } : {}),
            ...(resetUser.id ? { resetUserId: resetUser.id } : {}),
            warnings: resetWarnings,
        },
    };
}

export class AddonConfigError extends Error {
    constructor(message: string) {
        super(`Invalid add-on configuration: ${message}`);
        this.name = 'AddonConfigError';
    }
}

/**
 * Parses add-on settings, throwing so startup fails on a bad value. While
 * add-ons are off, only a bad BF_ADDONS_ENABLED throws.
 */
export function requireAddonConfig(env: Env): AddonConfig {
    const result = parseAddonConfig(env);
    if (!result.ok) throw new AddonConfigError(result.error);
    return result.config;
}

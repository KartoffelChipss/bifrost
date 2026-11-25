/**
 * Add-on configuration, parsed from the environment once at startup.
 *
 * Everything defaults to off, so a fresh deploy of the fork behaves exactly
 * like upstream Bifröst. The apply mode is never accepted from the
 * environment: an admin switches it on per guild link (safety guard 9).
 * The environment only decides whether that switch is allowed at all.
 */

export type AddonMode = 'read-only' | 'dry-run' | 'apply';

export interface AddonConfig {
    readonly enabled: boolean;
    readonly guildSync: boolean;
    readonly history: boolean;
    readonly identity: boolean;
    readonly initialMode: Exclude<AddonMode, 'apply'>;
    /** BF_ADDONS_ALLOW_APPLY. Without it, no add-on writes to a server. */
    readonly allowApply: boolean;
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

const BOOL_KEYS = {
    enabled: 'BF_ADDONS_ENABLED',
    guildSync: 'BF_ADDON_GUILD_SYNC',
    history: 'BF_ADDON_HISTORY',
    identity: 'BF_ADDON_IDENTITY',
    allowApply: 'BF_ADDONS_ALLOW_APPLY',
} as const;

/** Parses add-on settings from an environment map without side effects. */
export function parseAddonConfig(env: Env): AddonConfigResult {
    const flags: Record<keyof typeof BOOL_KEYS, boolean> = {
        enabled: false,
        guildSync: false,
        history: false,
        identity: false,
        allowApply: false,
    };
    for (const [field, envName] of Object.entries(BOOL_KEYS)) {
        const parsed = parseStrictBool(envName, env[envName]);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        flags[field as keyof typeof BOOL_KEYS] = parsed.value;
    }

    const mode = parseMode(env.BF_ADDONS_MODE);
    if (!mode.ok) return { ok: false, error: mode.error };

    // Read exactly as upstream does (src/utils/env.ts, src/db/sequelize.ts):
    // only the literal 'postgres' selects Postgres. The add-on tables use
    // JSONB and an advisory lock, so add-ons refuse to start without it.
    const dialect = env.BF_DB_DIALECT || 'sqlite';
    if (flags.enabled && dialect !== 'postgres') {
        return {
            ok: false,
            error: `BF_ADDONS_ENABLED needs BF_DB_DIALECT=postgres, got ${dialect}`,
        };
    }

    return {
        ok: true,
        config: {
            enabled: flags.enabled,
            guildSync: flags.enabled && flags.guildSync,
            history: flags.enabled && flags.history,
            identity: flags.enabled && flags.identity,
            initialMode: mode.value,
            allowApply: flags.enabled && flags.allowApply,
        },
    };
}

export class AddonConfigError extends Error {
    constructor(message: string) {
        super(`Invalid add-on configuration: ${message}`);
        this.name = 'AddonConfigError';
    }
}

/** Parses add-on settings, throwing so startup fails on a bad value. */
export function requireAddonConfig(env: Env): AddonConfig {
    const result = parseAddonConfig(env);
    if (!result.ok) throw new AddonConfigError(result.error);
    return result.config;
}

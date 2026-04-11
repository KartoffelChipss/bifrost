import dotenv from 'dotenv';
import fs from 'fs';
import { execSync } from 'child_process';

dotenv.config({ quiet: true });

function resolveFileSecret(varName: string) {
    const filePath = process.env[`${varName}_FILE`];
    if (filePath) {
        try {
            process.env[varName] = fs.readFileSync(filePath, 'utf8').trim();
        } catch (err) {
            console.error(
                `Error: Could not read secret file for ${varName} at "${filePath}": ${(err as Error).message}`
            );
            process.exit(1);
        }
    }
}

resolveFileSecret('BF_FLUXER_TOKEN');
resolveFileSecret('BF_DISCORD_TOKEN');
resolveFileSecret('BF_DB_PASS');
resolveFileSecret('BF_DISCORD_HEALTH_TOKEN');
resolveFileSecret('BF_FLUXER_HEALTH_TOKEN');

if (process.env.BF_DISCORD_HEALTH_TOKEN && process.env.BF_DISCORD_HEALTH_URL)
    process.env.BF_DISCORD_HEALTH_URL = `${process.env.BF_DISCORD_HEALTH_URL.replace(/\/$/, '')}/${process.env.BF_DISCORD_HEALTH_TOKEN}`;

if (process.env.BF_FLUXER_HEALTH_TOKEN && process.env.BF_FLUXER_HEALTH_URL)
    process.env.BF_FLUXER_HEALTH_URL = `${process.env.BF_FLUXER_HEALTH_URL.replace(/\/$/, '')}/${process.env.BF_FLUXER_HEALTH_TOKEN}`;

if (!process.env.BF_FLUXER_TOKEN) {
    console.error(
        'Error: BF_FLUXER_TOKEN or BF_FLUXER_TOKEN_FILE is not set in the environment variables.'
    );
    process.exit(1);
}

if (!process.env.BF_DISCORD_TOKEN) {
    console.error(
        'Error: BF_DISCORD_TOKEN or BF_DISCORD_TOKEN_FILE is not set in the environment variables.'
    );
    process.exit(1);
}

export const isProduction = process.env.NODE_ENV === 'production';

export const CONFIG_PATH = process.env.BF_CONFIG_PATH || './config';
export const COMMAND_PREFIX = process.env.BF_COMMAND_PREFIX || '!b ';

export const FLUXER_TOKEN = process.env.BF_FLUXER_TOKEN || '';
export const DISCORD_TOKEN = process.env.BF_DISCORD_TOKEN || '';

export const FLUXER_APP_ID = process.env.BF_FLUXER_APP_ID || '';
export const DISCORD_APP_ID = process.env.BF_DISCORD_APP_ID || '';

export const DISCORD_HEALTH_URL = process.env.BF_DISCORD_HEALTH_URL || null;
export const FLUXER_HEALTH_URL = process.env.BF_FLUXER_HEALTH_URL || null;

export const DB_DIALECT = process.env.BF_DB_DIALECT || 'sqlite';
export const DB_NAME = process.env.BF_DB_NAME || 'bifrost';
export const DB_USER = process.env.BF_DB_USER || 'root';
export const DB_PASS = process.env.BF_DB_PASS || '';
export const DB_HOST = process.env.BF_DB_HOST || 'localhost';
export const DB_PORT = process.env.BF_DB_PORT
    ? Number(process.env.BF_DB_PORT)
    : 5432;

export const METRICS_PORT = process.env.BF_METRICS_PORT
    ? Number(process.env.BF_METRICS_PORT)
    : 9091;

export const QUEUE_TTL_MS = process.env.BF_QUEUE_TTL_MS
    ? Number(process.env.BF_QUEUE_TTL_MS)
    : 5 * 60 * 1000;

function parseBool(value: string | undefined): boolean {
    return ['true', '1', 'yes'].includes((value ?? '').toLowerCase());
}

export const DELETE_INVOCATION = parseBool(process.env.BF_DELETE_INVOCATION);

export const DISCORD_OWNER_ID = process.env.BF_DISCORD_OWNER_ID || null;
export const FLUXER_OWNER_ID = process.env.BF_FLUXER_OWNER_ID || null;

function tryExec(cmd: string): string | null {
    try {
        const result = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
        return result || null;
    } catch (err) {
        console.warn(`[env] exec failed: "${cmd}" — ${err}`);
        return null;
    }
}

function parseRepoUrl(raw: string): string {
    // Convert SSH git@github.com:owner/repo.git → https://github.com/owner/repo
    return raw.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
}

export const GIT_COMMIT =
    process.env.GIT_COMMIT || tryExec('git rev-parse HEAD');
export const REPO_URL =
    process.env.REPO_URL ||
    (() => {
        const r = tryExec('git remote get-url origin');
        return r ? parseRepoUrl(r) : null;
    })();

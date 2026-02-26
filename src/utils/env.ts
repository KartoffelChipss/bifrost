import dotenv from 'dotenv';

dotenv.config({ quiet: true });

if (!process.env.FLUXER_BOT_TOKEN) {
    console.error('Error: FLUXER_BOT_TOKEN is not set in the environment variables.');
    process.exit(1);
}

if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('Error: DISCORD_BOT_TOKEN is not set in the environment variables.');
    process.exit(1);
}

export const isProduction = process.env.NODE_ENV === 'production';

export const CONFIG_PATH = process.env.CONFIG_PATH || './config';
export const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!b ';

export const FLUXER_BOT_TOKEN = process.env.FLUXER_BOT_TOKEN || '';
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

export const FLUXER_APPLICATION_ID = process.env.FLUXER_APPLICATION_ID || '';
export const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID || '';

export const DISCORD_HEALTH_PUSH_URL = process.env.DISCORD_HEALTH_PUSH_URL || null;
export const FLUXER_HEALTH_PUSH_URL = process.env.FLUXER_HEALTH_PUSH_URL || null;

export const DB_DIALECT = process.env.DB_DIALECT || 'sqlite';
export const DB_NAME = process.env.DB_NAME || 'bifrost';
export const DB_USER = process.env.DB_USER || 'root';
export const DB_PASS = process.env.DB_PASS || '';
export const DB_HOST = process.env.DB_HOST || 'localhost';
export const DB_PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432;

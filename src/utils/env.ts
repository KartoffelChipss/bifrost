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

export const CONFIG_PATH = process.env.CONFIG_PATH || './config';
export const isProduction = process.env.NODE_ENV === 'production';
export const FLUXER_BOT_TOKEN = process.env.FLUXER_BOT_TOKEN || '';
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
export const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!b ';
export const DISCORD_HEALTH_PUSH_URL = process.env.DISCORD_HEALTH_PUSH_URL || null;
export const FLUXER_HEALTH_PUSH_URL = process.env.FLUXER_HEALTH_PUSH_URL || null;
export const FLUXER_APPLICATION_ID = process.env.FLUXER_APPLICATION_ID || '';
export const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID || '';

import dotenv from 'dotenv';

dotenv.config({ quiet: true });

if (!process.env.FLUXER_BOT_TOKEN) {
    console.error('Error: FLUXER_BOT_TOKEN is not set in the environment variables.');
    process.exit(1);
}

export const CONFIG_PATH = process.env.CONFIG_PATH || './config';
export const isProduction = process.env.NODE_ENV === 'production';
export const FLUXER_BOT_TOKEN = process.env.FLUXER_BOT_TOKEN || '';
export const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!';

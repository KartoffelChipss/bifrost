import session from 'express-session';
import type { RequestHandler } from 'express';
import SequelizeSessionInit from 'connect-session-sequelize';
import sequelize from '../db/sequelize';
import { SESSION_SECRET, isProduction } from '../utils/env';

export interface StoredGuild {
    id: string;
    name: string;
    icon: string | null;
    /** Decimal bitfield string, as returned by the platform's OAuth guilds endpoint. */
    permissions: string;
}

export interface StoredIdentity {
    id: string;
    username: string;
    avatarUrl: string | null;
    guilds: StoredGuild[];
}

declare module 'express-session' {
    interface SessionData {
        discord?: StoredIdentity;
        fluxer?: StoredIdentity;
        oauthState?: { discord?: string; fluxer?: string };
    }
}

const SequelizeStore = SequelizeSessionInit(session.Store);

export function createSessionMiddleware(): RequestHandler {
    if (!SESSION_SECRET) {
        throw new Error(
            'BF_SESSION_SECRET is not set — required to run the web dashboard.'
        );
    }

    const store = new SequelizeStore({ db: sequelize, tableName: 'Sessions' });
    store.sync();

    return session({
        secret: SESSION_SECRET,
        store,
        resave: false,
        saveUninitialized: false,
        name: 'bifrost.sid',
        cookie: {
            httpOnly: true,
            secure: isProduction,
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000,
        },
    });
}

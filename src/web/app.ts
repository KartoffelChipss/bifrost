import express from 'express';
import path from 'path';
import type { Client as DiscordClient } from 'discord.js';
import { LinkService } from '../services/LinkService';
import { WebhookService } from '../services/WebhookService';
import { isProduction, WEB_TRUST_PROXY } from '../utils/env';
import logger from '../utils/logging/logger';
import type { FluxerClientRef } from './clientRefs';
import { createSessionMiddleware } from './session';
import authRouter from './routes/auth';
import invitesRouter from './routes/invites';
import { createGuildsRouter } from './routes/guilds';
import { createChannelsRouter } from './routes/channels';

const DASHBOARD_DIST = path.join(__dirname, '..', '..', 'dashboard', 'dist');

export function createWebApp({
    linkService,
    webhookService,
    discordClient,
    fluxerClientRef,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    discordClient: DiscordClient;
    fluxerClientRef: FluxerClientRef;
}): express.Express {
    const app = express();
    app.set('trust proxy', WEB_TRUST_PROXY);
    app.disable('x-powered-by');

    app.use(express.json());
    app.use(createSessionMiddleware());

    app.use('/api/auth', authRouter);
    app.use('/api', invitesRouter);
    app.use(
        '/api',
        createGuildsRouter({
            linkService,
            webhookService,
            discordClient,
            fluxerClientRef,
        })
    );
    app.use(
        '/api',
        createChannelsRouter({
            linkService,
            webhookService,
            discordClient,
            fluxerClientRef,
        })
    );

    app.use((req, res, next) => {
        if (req.path.startsWith('/api')) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        next();
    });

    if (isProduction) {
        app.use(express.static(DASHBOARD_DIST));
        app.get('/*splat', (_req, res) => {
            res.sendFile(path.join(DASHBOARD_DIST, 'index.html'));
        });
    } else {
        app.get('/', (_req, res) => {
            res.send(
                'Bifröst dashboard API is running. Run the dashboard dev server (pnpm --dir dashboard dev) for the UI.'
            );
        });
    }

    const errorHandler: express.ErrorRequestHandler = (
        err,
        _req,
        res,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next
    ) => {
        logger.error('Unhandled error in web dashboard request:', err);
        res.status(500).json({ error: 'Internal server error' });
    };
    app.use(errorHandler);

    return app;
}

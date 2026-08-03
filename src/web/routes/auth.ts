import { Router } from 'express';
import { randomBytes } from 'crypto';
import * as discordOAuth from '../oauth/discordOAuth';
import * as fluxerOAuth from '../oauth/fluxerOAuth';
import logger from '../../utils/logging/logger';
import type { MeResponse } from '../types';

const router: Router = Router();

router.get('/discord/login', (req, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauthState = { ...req.session.oauthState, discord: state };
    res.redirect(discordOAuth.buildAuthorizeUrl(state));
});

router.get('/discord/callback', async (req, res) => {
    const { code, state } = req.query;
    if (
        typeof code !== 'string' ||
        typeof state !== 'string' ||
        state !== req.session.oauthState?.discord
    ) {
        res.status(400).send('Invalid OAuth state or missing code.');
        return;
    }
    if (req.session.oauthState) delete req.session.oauthState.discord;

    try {
        req.session.discord = await discordOAuth.completeLogin(code);
        res.redirect('/');
    } catch (err) {
        logger.error('Discord OAuth callback failed:', err);
        res.status(500).send('Discord login failed.');
    }
});

router.get('/fluxer/login', (req, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauthState = { ...req.session.oauthState, fluxer: state };
    res.redirect(fluxerOAuth.buildAuthorizeUrl(state));
});

router.get('/fluxer/callback', async (req, res) => {
    const { code, state } = req.query;
    if (
        typeof code !== 'string' ||
        typeof state !== 'string' ||
        state !== req.session.oauthState?.fluxer
    ) {
        res.status(400).send('Invalid OAuth state or missing code.');
        return;
    }
    if (req.session.oauthState) delete req.session.oauthState.fluxer;

    try {
        req.session.fluxer = await fluxerOAuth.completeLogin(code);
        res.redirect('/');
    } catch (err) {
        logger.error('Fluxer OAuth callback failed:', err);
        res.status(500).send('Fluxer login failed.');
    }
});

router.get('/me', (req, res) => {
    const response: MeResponse = {
        discord: req.session.discord
            ? {
                  id: req.session.discord.id,
                  username: req.session.discord.username,
                  avatarUrl: req.session.discord.avatarUrl,
              }
            : null,
        fluxer: req.session.fluxer
            ? {
                  id: req.session.fluxer.id,
                  username: req.session.fluxer.username,
                  avatarUrl: req.session.fluxer.avatarUrl,
              }
            : null,
    };
    res.json(response);
});

router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            logger.error('Session destroy failed:', err);
            res.status(500).json({ error: 'Logout failed' });
            return;
        }
        res.status(204).end();
    });
});

export default router;

import { Router } from 'express';
import { UniqueConstraintError } from 'sequelize';
import type { Client } from 'discord.js';
import { AccountLinkService } from '../../services/AccountLinkService';
import {
    discordIdentity,
    fluxerIdentity,
} from '../../services/accountIdentity';
import type { FluxerClientRef } from '../clientRefs';
import { requireOwner } from '../middleware/auth';

export function createAccountsRouter({
    discordClient,
    fluxerClientRef,
    accountLinkService,
}: {
    accountLinkService: AccountLinkService;
    discordClient: Client;
    fluxerClientRef: FluxerClientRef;
}): Router {
    const router = Router();
    router.use('/accounts', requireOwner);
    router.get('/accounts', async (_req, res) => {
        const rows = await accountLinkService.list();
        const result = [];
        for (const row of rows) {
            const [discord, fluxer] = await Promise.all([
                discordIdentity(discordClient, undefined, row.discordUserId),
                fluxerClientRef.current
                    ? fluxerIdentity(
                          fluxerClientRef.current,
                          undefined,
                          row.fluxerUserId
                      )
                    : null,
            ]);
            result.push({
                id: row.id,
                discordUserId: row.discordUserId,
                fluxerUserId: row.fluxerUserId,
                discord,
                fluxer,
            });
        }
        res.json(result);
    });
    router.post('/accounts', async (req, res) => {
        const { discordUserId, fluxerUserId } = req.body ?? {};
        if (
            ![discordUserId, fluxerUserId].every(
                (id) => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id)
            )
        ) {
            res.status(400).json({
                error: 'Enter valid Discord and Fluxer account IDs as strings',
            });
            return;
        }
        try {
            const row = await accountLinkService.create(
                discordUserId,
                fluxerUserId
            );
            res.status(201).json({ id: row.id });
        } catch (error) {
            if (error instanceof UniqueConstraintError) {
                res.status(409).json({
                    error: 'An account is already linked. Remove its existing mapping first.',
                });
                return;
            }
            throw error;
        }
    });
    router.delete('/accounts/:id', async (req, res) => {
        await accountLinkService.remove(req.params.id);
        res.status(204).end();
    });
    return router;
}
